"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PaymentService = void 0;
const crypto_1 = __importDefault(require("crypto"));
const StateMachine_1 = require("../domain/StateMachine");
const TransactionRepo_1 = require("../infrastructure/db/TransactionRepo");
const RedisClient_1 = require("../infrastructure/cache/RedisClient");
const WebhookSender_1 = require("../infrastructure/webhook/WebhookSender");
const DomainErrors_1 = require("../domain/errors/DomainErrors");
const config_1 = require("../config");
const logger_1 = require("../utils/logger");
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
exports.PaymentService = {
    // ============================================================
    // Step 1: Initiate Payment
    // ============================================================
    async initiatePayment(input) {
        (0, logger_1.logPayment)('initiatePayment.start', 'new', {
            idempotencyKey: input.idempotencyKey,
            amount: input.amount,
        });
        // Check idempotency — return cached response if duplicate
        const cached = await RedisClient_1.IdempotencyCache.get(input.idempotencyKey);
        if (cached) {
            (0, logger_1.logPayment)('initiatePayment.idempotent_hit', 'cached', {
                key: input.idempotencyKey,
            });
            return cached.body;
        }
        // Check if transaction already exists in DB (for after Redis TTL)
        const existing = await TransactionRepo_1.TransactionRepo.findByIdempotencyKey(input.idempotencyKey);
        if (existing)
            return existing;
        // Create the transaction
        const txn = await TransactionRepo_1.TransactionRepo.create(input);
        // Generate OTP and store in Redis (expires in 5 mins)
        const otp = (0, StateMachine_1.generateMockOtp)();
        const otpHash = crypto_1.default
            .createHash('sha256')
            .update(otp)
            .digest('hex');
        await RedisClient_1.OTPStore.store(txn.id, otpHash);
        // Cache idempotency response
        await RedisClient_1.IdempotencyCache.setIfAbsent(input.idempotencyKey, {
            status: 201,
            body: txn,
        });
        // In real system: send OTP via SMS
        // We return it in response for simulation purposes
        (0, logger_1.logPayment)('initiatePayment.success', txn.id, { otp });
        // Audit initial state
        await TransactionRepo_1.TransactionRepo.getAuditLog(txn.id); // warms cache
        return { ...txn, metadata: { ...txn.metadata, simulatedOtp: otp } };
    },
    // ============================================================
    // Step 2: Authenticate User (OTP/PIN validation)
    // ============================================================
    async authenticateUser(transactionId, otp) {
        (0, logger_1.logPayment)('authenticateUser.start', transactionId);
        const txn = await TransactionRepo_1.TransactionRepo.findByIdOrThrow(transactionId);
        // Pure: validate transition
        const result = (0, StateMachine_1.validateTransition)(txn.status, 'AUTHENTICATED');
        if (!result.ok)
            throw result.error;
        // Validate OTP — consume atomically (prevents replay attacks)
        const storedHash = await RedisClient_1.OTPStore.consume(transactionId);
        if (!storedHash) {
            // OTP expired or not found
            // Transition to FAILED
            await TransactionRepo_1.TransactionRepo.transitionStatus(transactionId, 'FAILED', { failureReason: 'OTP_EXPIRED' }, { transactionId, fromStatus: txn.status, toStatus: 'FAILED', triggeredBy: 'user', reason: 'OTP expired' });
            throw new DomainErrors_1.InvalidOTPError();
        }
        const providedHash = crypto_1.default
            .createHash('sha256')
            .update(otp)
            .digest('hex');
        if (providedHash !== storedHash) {
            (0, logger_1.logPayment)('authenticateUser.invalid_otp', transactionId);
            throw new DomainErrors_1.InvalidOTPError();
        }
        const updated = await TransactionRepo_1.TransactionRepo.transitionStatus(transactionId, 'AUTHENTICATED', {}, {
            transactionId,
            fromStatus: txn.status,
            toStatus: 'AUTHENTICATED',
            triggeredBy: 'user',
        });
        await RedisClient_1.TransactionCache.invalidate(transactionId);
        (0, logger_1.logPayment)('authenticateUser.success', transactionId);
        return updated;
    },
    // ============================================================
    // Step 3: Process Payment
    // ============================================================
    async processPayment(transactionId) {
        (0, logger_1.logPayment)('processPayment.start', transactionId);
        // Acquire distributed lock — prevents duplicate processing
        const lockKey = `process:${transactionId}`;
        const locked = await RedisClient_1.DistributedLock.acquire(lockKey, 30000);
        if (!locked) {
            throw new DomainErrors_1.DomainError('DUPLICATE_TRANSACTION', 'Payment is already being processed', 409);
        }
        try {
            const txn = await TransactionRepo_1.TransactionRepo.findByIdOrThrow(transactionId);
            const toProcessing = (0, StateMachine_1.validateTransition)(txn.status, 'PROCESSING');
            if (!toProcessing.ok)
                throw toProcessing.error;
            // Move to PROCESSING first — important for observability
            await TransactionRepo_1.TransactionRepo.transitionStatus(transactionId, 'PROCESSING', {}, { transactionId, fromStatus: txn.status, toStatus: 'PROCESSING', triggeredBy: 'system' });
            // Simulate bank/NPCI call with configured delay
            await sleep(config_1.config.payment.processingDelayMs);
            const bankResult = (0, StateMachine_1.simulateBankResponse)(config_1.config.payment.successRate);
            const finalStatus = bankResult.success ? 'SUCCESS' : 'FAILED';
            const updated = await TransactionRepo_1.TransactionRepo.transitionStatus(transactionId, finalStatus, {
                bankReferenceId: bankResult.bankReferenceId,
                failureReason: bankResult.failureReason,
            }, {
                transactionId,
                fromStatus: 'PROCESSING',
                toStatus: finalStatus,
                triggeredBy: 'system',
                reason: bankResult.failureReason,
                metadata: { bankReferenceId: bankResult.bankReferenceId },
            });
            await RedisClient_1.TransactionCache.invalidate(transactionId);
            // Dispatch webhooks (non-blocking — payment response is not delayed)
            const eventType = bankResult.success ? 'PAYMENT_SUCCESS' : 'PAYMENT_FAILED';
            const webhookPayload = (0, StateMachine_1.buildWebhookPayload)(eventType, transactionId, finalStatus, txn.amount, txn.currency, { bankReferenceId: bankResult.bankReferenceId });
            (0, WebhookSender_1.dispatchWebhooks)(transactionId, txn.merchantId, eventType, webhookPayload);
            (0, logger_1.logPayment)('processPayment.complete', transactionId, {
                status: finalStatus,
                bankReferenceId: bankResult.bankReferenceId,
            });
            return updated;
        }
        finally {
            await RedisClient_1.DistributedLock.release(lockKey);
        }
    },
    // ============================================================
    // Step 4: Reconcile Transaction
    // ============================================================
    async reconcileTransaction(transactionId) {
        (0, logger_1.logPayment)('reconcileTransaction.start', transactionId);
        const txn = await TransactionRepo_1.TransactionRepo.findByIdOrThrow(transactionId);
        const result = (0, StateMachine_1.validateTransition)(txn.status, 'RECONCILED');
        if (!result.ok)
            throw result.error;
        const updated = await TransactionRepo_1.TransactionRepo.transitionStatus(transactionId, 'RECONCILED', {}, {
            transactionId,
            fromStatus: txn.status,
            toStatus: 'RECONCILED',
            triggeredBy: 'system',
            reason: 'Manual or scheduled reconciliation',
        });
        await RedisClient_1.TransactionCache.invalidate(transactionId);
        // Dispatch reconciliation webhook
        const webhookPayload = (0, StateMachine_1.buildWebhookPayload)('PAYMENT_RECONCILED', transactionId, 'RECONCILED', txn.amount, txn.currency);
        (0, WebhookSender_1.dispatchWebhooks)(transactionId, txn.merchantId, 'PAYMENT_RECONCILED', webhookPayload);
        (0, logger_1.logPayment)('reconcileTransaction.success', transactionId);
        return updated;
    },
    // ============================================================
    // Get transaction status (with Redis cache)
    // ============================================================
    async getTransaction(transactionId) {
        // Try cache first
        const cached = await RedisClient_1.TransactionCache.get(transactionId);
        if (cached)
            return cached;
        const txn = await TransactionRepo_1.TransactionRepo.findByIdOrThrow(transactionId);
        // Cache it for next time
        await RedisClient_1.TransactionCache.set(transactionId, txn);
        return txn;
    },
    // ============================================================
    // Retry failed payment with exponential backoff
    // ============================================================
    async retryPayment(transactionId) {
        const txn = await TransactionRepo_1.TransactionRepo.findByIdOrThrow(transactionId);
        if (txn.status !== 'FAILED') {
            throw new DomainErrors_1.InvalidTransitionError(txn.status, 'retry');
        }
        if (txn.retryCount >= config_1.config.retry.maxAttempts) {
            throw new DomainErrors_1.DomainError('PAYMENT_PROCESSING_FAILED', `Max retry attempts (${config_1.config.retry.maxAttempts}) exceeded`, 422);
        }
        const delay = (0, StateMachine_1.computeBackoffDelay)(txn.retryCount, config_1.config.retry.baseDelayMs, config_1.config.retry.maxDelayMs);
        (0, logger_1.logPayment)('retryPayment.scheduled', transactionId, {
            attempt: txn.retryCount + 1,
            delayMs: delay,
        });
        // Log retry attempt
        await TransactionRepo_1.TransactionRepo.logRetry(transactionId, txn.retryCount + 1, delay, 'User-initiated retry', 'SCHEDULED');
        // Reset to INITIATED so user can re-authenticate
        const resetTxn = await TransactionRepo_1.TransactionRepo.transitionStatus(transactionId, 'INITIATED', { retryCount: txn.retryCount + 1 }, {
            transactionId,
            fromStatus: 'FAILED',
            toStatus: 'INITIATED',
            triggeredBy: 'retry',
            reason: `Retry attempt ${txn.retryCount + 1}`,
            metadata: { delayMs: delay },
        });
        // Generate new OTP for re-authentication
        const otp = (0, StateMachine_1.generateMockOtp)();
        const otpHash = crypto_1.default.createHash('sha256').update(otp).digest('hex');
        await RedisClient_1.OTPStore.store(transactionId, otpHash);
        await RedisClient_1.TransactionCache.invalidate(transactionId);
        return { ...resetTxn, metadata: { ...resetTxn.metadata, simulatedOtp: otp } };
    },
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
//# sourceMappingURL=PaymentService.js.map