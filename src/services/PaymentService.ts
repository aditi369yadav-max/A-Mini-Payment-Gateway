import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { Transaction, CreateTransactionInput } from '../domain/Transaction';
import {
  validateTransition,
  simulateBankResponse,
  buildWebhookPayload,
  computeBackoffDelay,
  generateMockOtp,
} from '../domain/StateMachine';
import { TransactionRepo } from '../infrastructure/db/TransactionRepo';
import {
  IdempotencyCache,
  TransactionCache,
  OTPStore,
  DistributedLock,
} from '../infrastructure/cache/RedisClient';
import { dispatchWebhooks } from '../infrastructure/webhook/WebhookSender';
import {
  InvalidOTPError,
  InvalidTransitionError,
  DomainError,
} from '../domain/errors/DomainErrors';
import { config } from '../config';
import { logger, logPayment, logError } from '../utils/logger';

// ============================================================
// PaymentService — orchestrates business logic
//
// Structure:
//   1. Validate idempotency
//   2. Acquire distributed lock (prevent race conditions)
//   3. Validate state transition (pure function)
//   4. Perform side effects (DB, Redis, Webhooks)
//   5. Release lock
//
// All state transitions go through this layer — never update
// DB status directly from a route handler.
// ============================================================

export const PaymentService = {
  // ============================================================
  // Step 1: Initiate Payment
  // ============================================================
  async initiatePayment(input: CreateTransactionInput): Promise<Transaction> {
    logPayment('initiatePayment.start', 'new', {
      idempotencyKey: input.idempotencyKey,
      amount: input.amount,
    });

    // Check idempotency — return cached response if duplicate
    const cached = await IdempotencyCache.get(input.idempotencyKey);
    if (cached) {
      logPayment('initiatePayment.idempotent_hit', 'cached', {
        key: input.idempotencyKey,
      });
      return cached.body as Transaction;
    }

    // Check if transaction already exists in DB (for after Redis TTL)
    const existing = await TransactionRepo.findByIdempotencyKey(
      input.idempotencyKey
    );
    if (existing) return existing;

    // Create the transaction
    const txn = await TransactionRepo.create(input);

    // Generate OTP and store in Redis (expires in 5 mins)
    const otp = generateMockOtp();
    const otpHash = crypto
      .createHash('sha256')
      .update(otp)
      .digest('hex');
    await OTPStore.store(txn.id, otpHash);

    // Cache idempotency response
    await IdempotencyCache.setIfAbsent(input.idempotencyKey, {
      status: 201,
      body: txn,
    });

    // In real system: send OTP via SMS
    // We return it in response for simulation purposes
    logPayment('initiatePayment.success', txn.id, { otp });

    // Audit initial state
    await TransactionRepo.getAuditLog(txn.id); // warms cache

    return { ...txn, metadata: { ...txn.metadata, simulatedOtp: otp } };
  },

  // ============================================================
  // Step 2: Authenticate User (OTP/PIN validation)
  // ============================================================
  async authenticateUser(
    transactionId: string,
    otp: string
  ): Promise<Transaction> {
    logPayment('authenticateUser.start', transactionId);

    const txn = await TransactionRepo.findByIdOrThrow(transactionId);

    // Pure: validate transition
    const result = validateTransition(txn.status, 'AUTHENTICATED');
    if (!result.ok) throw (result as any).error;

    // Validate OTP — consume atomically (prevents replay attacks)
    const storedHash = await OTPStore.consume(transactionId);

    if (!storedHash) {
      // OTP expired or not found
      // Transition to FAILED
      await TransactionRepo.transitionStatus(
        transactionId, 'FAILED',
        { failureReason: 'OTP_EXPIRED' },
        { transactionId, fromStatus: txn.status, toStatus: 'FAILED', triggeredBy: 'user', reason: 'OTP expired' }
      );
      throw new InvalidOTPError();
    }

    const providedHash = crypto
      .createHash('sha256')
      .update(otp)
      .digest('hex');

    if (providedHash !== storedHash) {
      logPayment('authenticateUser.invalid_otp', transactionId);
      throw new InvalidOTPError();
    }

    const updated = await TransactionRepo.transitionStatus(
      transactionId, 'AUTHENTICATED',
      {},
      {
        transactionId,
        fromStatus: txn.status,
        toStatus: 'AUTHENTICATED',
        triggeredBy: 'user',
      }
    );

    await TransactionCache.invalidate(transactionId);
    logPayment('authenticateUser.success', transactionId);
    return updated;
  },

  // ============================================================
  // Step 3: Process Payment
  // ============================================================
  async processPayment(transactionId: string): Promise<Transaction> {
    logPayment('processPayment.start', transactionId);

    // Acquire distributed lock — prevents duplicate processing
    const lockKey = `process:${transactionId}`;
    const locked = await DistributedLock.acquire(lockKey, 30_000);
    if (!locked) {
      throw new DomainError(
        'DUPLICATE_TRANSACTION',
        'Payment is already being processed',
        409
      );
    }

    try {
      const txn = await TransactionRepo.findByIdOrThrow(transactionId);

      const toProcessing = validateTransition(txn.status, 'PROCESSING');
      if (!toProcessing.ok) throw (toProcessing as any).error;

      // Move to PROCESSING first — important for observability
      await TransactionRepo.transitionStatus(
        transactionId, 'PROCESSING', {},
        { transactionId, fromStatus: txn.status, toStatus: 'PROCESSING', triggeredBy: 'system' }
      );

      // Simulate bank/NPCI call with configured delay
      await sleep(config.payment.processingDelayMs);
      const bankResult = simulateBankResponse(config.payment.successRate);

      const finalStatus = bankResult.success ? 'SUCCESS' : 'FAILED';

      const updated = await TransactionRepo.transitionStatus(
        transactionId, finalStatus,
        {
          bankReferenceId: bankResult.bankReferenceId,
          failureReason:   bankResult.failureReason,
        },
        {
          transactionId,
          fromStatus: 'PROCESSING',
          toStatus: finalStatus,
          triggeredBy: 'system',
          reason: bankResult.failureReason,
          metadata: { bankReferenceId: bankResult.bankReferenceId },
        }
      );

      await TransactionCache.invalidate(transactionId);

      // Dispatch webhooks (non-blocking — payment response is not delayed)
      const eventType = bankResult.success ? 'PAYMENT_SUCCESS' : 'PAYMENT_FAILED';
      const webhookPayload = buildWebhookPayload(
        eventType, transactionId, finalStatus,
        txn.amount, txn.currency, { bankReferenceId: bankResult.bankReferenceId }
      );

      dispatchWebhooks(transactionId, txn.merchantId, eventType, webhookPayload);

      logPayment('processPayment.complete', transactionId, {
        status: finalStatus,
        bankReferenceId: bankResult.bankReferenceId,
      });

      return updated;
    } finally {
      await DistributedLock.release(lockKey);
    }
  },

  // ============================================================
  // Step 4: Reconcile Transaction
  // ============================================================
  async reconcileTransaction(transactionId: string): Promise<Transaction> {
    logPayment('reconcileTransaction.start', transactionId);

    const txn = await TransactionRepo.findByIdOrThrow(transactionId);

    const result = validateTransition(txn.status, 'RECONCILED');
    if (!result.ok) throw (result as any).error;

    const updated = await TransactionRepo.transitionStatus(
      transactionId, 'RECONCILED', {},
      {
        transactionId,
        fromStatus: txn.status,
        toStatus: 'RECONCILED',
        triggeredBy: 'system',
        reason: 'Manual or scheduled reconciliation',
      }
    );

    await TransactionCache.invalidate(transactionId);

    // Dispatch reconciliation webhook
    const webhookPayload = buildWebhookPayload(
      'PAYMENT_RECONCILED', transactionId, 'RECONCILED',
      txn.amount, txn.currency
    );
    dispatchWebhooks(transactionId, txn.merchantId, 'PAYMENT_RECONCILED', webhookPayload);

    logPayment('reconcileTransaction.success', transactionId);
    return updated;
  },

  // ============================================================
  // Get transaction status (with Redis cache)
  // ============================================================
  async getTransaction(transactionId: string): Promise<Transaction> {
    // Try cache first
    const cached = await TransactionCache.get(transactionId);
    if (cached) return cached as Transaction;

    const txn = await TransactionRepo.findByIdOrThrow(transactionId);

    // Cache it for next time
    await TransactionCache.set(transactionId, txn);

    return txn;
  },

  // ============================================================
  // Retry failed payment with exponential backoff
  // ============================================================
  async retryPayment(transactionId: string): Promise<Transaction> {
    const txn = await TransactionRepo.findByIdOrThrow(transactionId);

    if (txn.status !== 'FAILED') {
      throw new InvalidTransitionError(txn.status, 'retry');
    }

    if (txn.retryCount >= config.retry.maxAttempts) {
      throw new DomainError(
        'PAYMENT_PROCESSING_FAILED',
        `Max retry attempts (${config.retry.maxAttempts}) exceeded`,
        422
      );
    }

    const delay = computeBackoffDelay(
      txn.retryCount,
      config.retry.baseDelayMs,
      config.retry.maxDelayMs
    );

    logPayment('retryPayment.scheduled', transactionId, {
      attempt: txn.retryCount + 1,
      delayMs: delay,
    });

    // Log retry attempt
    await TransactionRepo.logRetry(
      transactionId,
      txn.retryCount + 1,
      delay,
      'User-initiated retry',
      'SCHEDULED'
    );

    // Reset to INITIATED so user can re-authenticate
    const resetTxn = await TransactionRepo.transitionStatus(
      transactionId, 'INITIATED',
      { retryCount: txn.retryCount + 1 },
      {
        transactionId,
        fromStatus: 'FAILED',
        toStatus: 'INITIATED',
        triggeredBy: 'retry',
        reason: `Retry attempt ${txn.retryCount + 1}`,
        metadata: { delayMs: delay },
      }
    );

    // Generate new OTP for re-authentication
    const otp = generateMockOtp();
    const otpHash = crypto.createHash('sha256').update(otp).digest('hex');
    await OTPStore.store(transactionId, otpHash);

    await TransactionCache.invalidate(transactionId);

    return { ...resetTxn, metadata: { ...resetTxn.metadata, simulatedOtp: otp } };
  },
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
