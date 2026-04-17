"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.paymentRoutes = void 0;
const express_1 = require("express");
const express_validator_1 = require("express-validator");
const PaymentService_1 = require("../../services/PaymentService");
const idempotency_middleware_1 = require("../middleware/idempotency.middleware");
const router = (0, express_1.Router)();
exports.paymentRoutes = router;
// ============================================================
// Validation helper — always validate at the boundary
// ============================================================
const validate = (req, res, next) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty()) {
        res.status(400).json({
            error: 'Validation failed',
            code: 'VALIDATION_ERROR',
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
router.post('/initiate', idempotency_middleware_1.idempotencyMiddleware, [
    (0, express_validator_1.body)('amount')
        .isFloat({ min: 0.01 })
        .withMessage('amount must be a positive number'),
    (0, express_validator_1.body)('payerUpiId')
        .isString()
        .matches(/^[\w.-]+@[\w.-]+$/)
        .withMessage('Invalid payer UPI ID (format: user@bank)'),
    (0, express_validator_1.body)('payeeUpiId')
        .isString()
        .matches(/^[\w.-]+@[\w.-]+$/)
        .withMessage('Invalid payee UPI ID (format: merchant@bank)'),
    (0, express_validator_1.body)('merchantId')
        .isString()
        .notEmpty()
        .withMessage('merchantId is required'),
    (0, express_validator_1.body)('currency')
        .optional()
        .isIn(['INR', 'USD', 'EUR'])
        .withMessage('currency must be INR, USD, or EUR'),
], validate, async (req, res, next) => {
    try {
        const txn = await PaymentService_1.PaymentService.initiatePayment({
            idempotencyKey: req.idempotencyKey,
            amount: parseFloat(req.body.amount),
            currency: req.body.currency ?? 'INR',
            payerUpiId: req.body.payerUpiId,
            payeeUpiId: req.body.payeeUpiId,
            merchantId: req.body.merchantId,
            description: req.body.description,
            metadata: req.body.metadata,
        });
        res.status(201).json({
            success: true,
            transactionId: txn.id,
            status: txn.status,
            amount: txn.amount,
            currency: txn.currency,
            payerUpiId: txn.payerUpiId,
            payeeUpiId: txn.payeeUpiId,
            simulatedOtp: txn.metadata.simulatedOtp,
            message: 'OTP sent to payer. Use POST /authenticate to verify.',
            createdAt: txn.createdAt,
        });
    }
    catch (error) {
        next(error);
    }
});
// ============================================================
// POST /api/payments/:transactionId/authenticate
// Step 2: Verify OTP to authenticate the payer
// ============================================================
router.post('/:transactionId/authenticate', [
    (0, express_validator_1.param)('transactionId').isUUID().withMessage('Invalid transaction ID'),
    (0, express_validator_1.body)('otp')
        .isString()
        .isLength({ min: 6, max: 6 })
        .isNumeric()
        .withMessage('OTP must be a 6-digit number'),
], validate, async (req, res, next) => {
    try {
        const txn = await PaymentService_1.PaymentService.authenticateUser(req.params.transactionId, req.body.otp);
        res.status(200).json({
            success: true,
            transactionId: txn.id,
            status: txn.status,
            authenticatedAt: txn.authenticatedAt,
            message: 'Authentication successful. Call POST /process to complete payment.',
        });
    }
    catch (error) {
        next(error);
    }
});
// ============================================================
// POST /api/payments/:transactionId/process
// Step 3: Process the payment (calls bank/NPCI simulation)
// ============================================================
router.post('/:transactionId/process', [
    (0, express_validator_1.param)('transactionId').isUUID().withMessage('Invalid transaction ID'),
], validate, async (req, res, next) => {
    try {
        const txn = await PaymentService_1.PaymentService.processPayment(req.params.transactionId);
        res.status(200).json({
            success: true,
            transactionId: txn.id,
            status: txn.status,
            amount: txn.amount,
            currency: txn.currency,
            bankReferenceId: txn.bankReferenceId,
            failureReason: txn.failureReason,
            processedAt: txn.processedAt,
            message: txn.status === 'SUCCESS'
                ? 'Payment processed successfully.'
                : `Payment failed: ${txn.failureReason}. Call POST /retry to retry.`,
        });
    }
    catch (error) {
        next(error);
    }
});
// ============================================================
// POST /api/payments/:transactionId/reconcile
// Step 4: Mark transaction as reconciled (final state)
// ============================================================
router.post('/:transactionId/reconcile', [
    (0, express_validator_1.param)('transactionId').isUUID().withMessage('Invalid transaction ID'),
], validate, async (req, res, next) => {
    try {
        const txn = await PaymentService_1.PaymentService.reconcileTransaction(req.params.transactionId);
        res.status(200).json({
            success: true,
            transactionId: txn.id,
            status: txn.status,
            reconciledAt: txn.reconciledAt,
            bankReferenceId: txn.bankReferenceId,
            amount: txn.amount,
            currency: txn.currency,
            message: 'Transaction reconciled. Final state reached.',
        });
    }
    catch (error) {
        next(error);
    }
});
// ============================================================
// POST /api/payments/:transactionId/retry
// Retry a FAILED payment (resets to INITIATED with new OTP)
// ============================================================
router.post('/:transactionId/retry', [
    (0, express_validator_1.param)('transactionId').isUUID().withMessage('Invalid transaction ID'),
], validate, async (req, res, next) => {
    try {
        const txn = await PaymentService_1.PaymentService.retryPayment(req.params.transactionId);
        res.status(200).json({
            success: true,
            transactionId: txn.id,
            status: txn.status,
            retryCount: txn.retryCount,
            simulatedOtp: txn.metadata.simulatedOtp,
            message: `Retry attempt ${txn.retryCount}. New OTP issued. Re-authenticate to continue.`,
        });
    }
    catch (error) {
        next(error);
    }
});
// ============================================================
// GET /api/payments/:transactionId
// Get current status of a transaction
// ============================================================
router.get('/:transactionId', [
    (0, express_validator_1.param)('transactionId').isUUID().withMessage('Invalid transaction ID'),
], validate, async (req, res, next) => {
    try {
        const txn = await PaymentService_1.PaymentService.getTransaction(req.params.transactionId);
        res.status(200).json({
            success: true,
            transactionId: txn.id,
            status: txn.status,
            amount: txn.amount,
            currency: txn.currency,
            payerUpiId: txn.payerUpiId,
            payeeUpiId: txn.payeeUpiId,
            merchantId: txn.merchantId,
            retryCount: txn.retryCount,
            failureReason: txn.failureReason,
            bankReferenceId: txn.bankReferenceId,
            createdAt: txn.createdAt,
            updatedAt: txn.updatedAt,
            authenticatedAt: txn.authenticatedAt,
            processedAt: txn.processedAt,
            reconciledAt: txn.reconciledAt,
        });
    }
    catch (error) {
        next(error);
    }
});
// ============================================================
// GET /api/payments/:transactionId/audit
// Full audit trail of all state transitions
// ============================================================
router.get('/:transactionId/audit', [
    (0, express_validator_1.param)('transactionId').isUUID().withMessage('Invalid transaction ID'),
], validate, async (req, res, next) => {
    try {
        // Verify transaction exists
        await PaymentService_1.PaymentService.getTransaction(req.params.transactionId);
        const auditLog = await (await Promise.resolve().then(() => __importStar(require('../../infrastructure/db/TransactionRepo')))).TransactionRepo.getAuditLog(req.params.transactionId);
        res.status(200).json({
            success: true,
            transactionId: req.params.transactionId,
            auditLog,
        });
    }
    catch (error) {
        next(error);
    }
});
//# sourceMappingURL=payment.routes.js.map