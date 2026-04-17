import { Router, Request, Response, NextFunction } from 'express';
import { body, param, validationResult } from 'express-validator';
import { PaymentService } from '../../services/PaymentService';
import { idempotencyMiddleware } from '../middleware/idempotency.middleware';

const router = Router();

// ============================================================
// Validation helper — always validate at the boundary
// ============================================================
const validate = (req: Request, res: Response, next: NextFunction): void => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({
      error:   'Validation failed',
      code:    'VALIDATION_ERROR',
      details: errors.array(),
    });
    return;
  }
  next();
};

// ============================================================
// POST /api/payments/initiate
// Step 1: Create a new payment transaction
//
// Requires Idempotency-Key header — safe to retry
// ============================================================
router.post(
  '/initiate',
  idempotencyMiddleware,
  [
    body('amount')
      .isFloat({ min: 0.01 })
      .withMessage('amount must be a positive number'),
    body('payerUpiId')
      .isString()
      .matches(/^[\w.-]+@[\w.-]+$/)
      .withMessage('Invalid payer UPI ID (format: user@bank)'),
    body('payeeUpiId')
      .isString()
      .matches(/^[\w.-]+@[\w.-]+$/)
      .withMessage('Invalid payee UPI ID (format: merchant@bank)'),
    body('merchantId')
      .isString()
      .notEmpty()
      .withMessage('merchantId is required'),
    body('currency')
      .optional()
      .isIn(['INR', 'USD', 'EUR'])
      .withMessage('currency must be INR, USD, or EUR'),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const txn = await PaymentService.initiatePayment({
        idempotencyKey: req.idempotencyKey!,
        amount:         parseFloat(req.body.amount),
        currency:       req.body.currency ?? 'INR',
        payerUpiId:     req.body.payerUpiId,
        payeeUpiId:     req.body.payeeUpiId,
        merchantId:     req.body.merchantId,
        description:    req.body.description,
        metadata:       req.body.metadata,
      });

      res.status(201).json({
        success:       true,
        transactionId: txn.id,
        status:        txn.status,
        amount:        txn.amount,
        currency:      txn.currency,
        payerUpiId:    txn.payerUpiId,
        payeeUpiId:    txn.payeeUpiId,
        simulatedOtp:  (txn.metadata as Record<string, unknown>).simulatedOtp,
        message:       'OTP sent to payer. Use POST /authenticate to verify.',
        createdAt:     txn.createdAt,
      });
    } catch (error) {
      next(error);
    }
  }
);

// ============================================================
// POST /api/payments/:transactionId/authenticate
// Step 2: Verify OTP to authenticate the payer
// ============================================================
router.post(
  '/:transactionId/authenticate',
  [
    param('transactionId').isUUID().withMessage('Invalid transaction ID'),
    body('otp')
      .isString()
      .isLength({ min: 6, max: 6 })
      .isNumeric()
      .withMessage('OTP must be a 6-digit number'),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const txn = await PaymentService.authenticateUser(
        req.params.transactionId,
        req.body.otp
      );

      res.status(200).json({
        success:       true,
        transactionId: txn.id,
        status:        txn.status,
        authenticatedAt: txn.authenticatedAt,
        message:       'Authentication successful. Call POST /process to complete payment.',
      });
    } catch (error) {
      next(error);
    }
  }
);

// ============================================================
// POST /api/payments/:transactionId/process
// Step 3: Process the payment (calls bank/NPCI simulation)
// ============================================================
router.post(
  '/:transactionId/process',
  [
    param('transactionId').isUUID().withMessage('Invalid transaction ID'),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const txn = await PaymentService.processPayment(req.params.transactionId);

      res.status(200).json({
        success:         true,
        transactionId:   txn.id,
        status:          txn.status,
        amount:          txn.amount,
        currency:        txn.currency,
        bankReferenceId: txn.bankReferenceId,
        failureReason:   txn.failureReason,
        processedAt:     txn.processedAt,
        message:         txn.status === 'SUCCESS'
          ? 'Payment processed successfully.'
          : `Payment failed: ${txn.failureReason}. Call POST /retry to retry.`,
      });
    } catch (error) {
      next(error);
    }
  }
);

// ============================================================
// POST /api/payments/:transactionId/reconcile
// Step 4: Mark transaction as reconciled (final state)
// ============================================================
router.post(
  '/:transactionId/reconcile',
  [
    param('transactionId').isUUID().withMessage('Invalid transaction ID'),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const txn = await PaymentService.reconcileTransaction(
        req.params.transactionId
      );

      res.status(200).json({
        success:        true,
        transactionId:  txn.id,
        status:         txn.status,
        reconciledAt:   txn.reconciledAt,
        bankReferenceId: txn.bankReferenceId,
        amount:         txn.amount,
        currency:       txn.currency,
        message:        'Transaction reconciled. Final state reached.',
      });
    } catch (error) {
      next(error);
    }
  }
);

// ============================================================
// POST /api/payments/:transactionId/retry
// Retry a FAILED payment (resets to INITIATED with new OTP)
// ============================================================
router.post(
  '/:transactionId/retry',
  [
    param('transactionId').isUUID().withMessage('Invalid transaction ID'),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const txn = await PaymentService.retryPayment(req.params.transactionId);

      res.status(200).json({
        success:       true,
        transactionId: txn.id,
        status:        txn.status,
        retryCount:    txn.retryCount,
        simulatedOtp:  (txn.metadata as Record<string, unknown>).simulatedOtp,
        message:       `Retry attempt ${txn.retryCount}. New OTP issued. Re-authenticate to continue.`,
      });
    } catch (error) {
      next(error);
    }
  }
);

// ============================================================
// GET /api/payments/:transactionId
// Get current status of a transaction
// ============================================================
router.get(
  '/:transactionId',
  [
    param('transactionId').isUUID().withMessage('Invalid transaction ID'),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const txn = await PaymentService.getTransaction(req.params.transactionId);

      res.status(200).json({
        success:         true,
        transactionId:   txn.id,
        status:          txn.status,
        amount:          txn.amount,
        currency:        txn.currency,
        payerUpiId:      txn.payerUpiId,
        payeeUpiId:      txn.payeeUpiId,
        merchantId:      txn.merchantId,
        retryCount:      txn.retryCount,
        failureReason:   txn.failureReason,
        bankReferenceId: txn.bankReferenceId,
        createdAt:       txn.createdAt,
        updatedAt:       txn.updatedAt,
        authenticatedAt: txn.authenticatedAt,
        processedAt:     txn.processedAt,
        reconciledAt:    txn.reconciledAt,
      });
    } catch (error) {
      next(error);
    }
  }
);

// ============================================================
// GET /api/payments/:transactionId/audit
// Full audit trail of all state transitions
// ============================================================
router.get(
  '/:transactionId/audit',
  [
    param('transactionId').isUUID().withMessage('Invalid transaction ID'),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Verify transaction exists
      await PaymentService.getTransaction(req.params.transactionId);
      const auditLog = await (
        await import('../../infrastructure/db/TransactionRepo')
      ).TransactionRepo.getAuditLog(req.params.transactionId);

      res.status(200).json({
        success:       true,
        transactionId: req.params.transactionId,
        auditLog,
      });
    } catch (error) {
      next(error);
    }
  }
);

export { router as paymentRoutes };
