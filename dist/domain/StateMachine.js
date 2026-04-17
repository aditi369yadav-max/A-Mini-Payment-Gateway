"use strict";
// ============================================================
// State Machine — 100% Pure Functions
//
// This is the most important file in the project from an FP
// perspective. Every function here:
//   1. Takes inputs
//   2. Returns outputs
//   3. Touches NOTHING external (no DB, no Redis, no HTTP)
//
// This mirrors exactly what Juspay does in Haskell — business
// logic expressed as pure transformations.
// ============================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.simulateBankResponse = exports.generateMockOtp = exports.buildWebhookPayload = exports.shouldRetryWebhook = exports.computeNextRetryAt = exports.computeBackoffDelay = exports.isTerminalState = exports.getValidNextStates = exports.canTransition = exports.validateTransition = void 0;
const DomainErrors_1 = require("./errors/DomainErrors");
// ============================================================
// Transition table — encoded as pure data, not imperative code
// This is the authoritative source of truth for what's allowed
// ============================================================
const VALID_TRANSITIONS = Object.freeze({
    INITIATED: ['AUTHENTICATED', 'FAILED'],
    AUTHENTICATED: ['PROCESSING', 'FAILED'],
    PROCESSING: ['SUCCESS', 'FAILED'],
    SUCCESS: ['RECONCILED'],
    FAILED: ['INITIATED'], // allows retry
    RECONCILED: [], // terminal
});
// Terminal states — no exit
const TERMINAL_STATES = new Set([
    'RECONCILED',
]);
const ok = (value) => ({ ok: true, value });
const err = (error) => ({ ok: false, error });
// ============================================================
// Pure: validate a transition without performing it
// ============================================================
const validateTransition = (from, to) => {
    if (TERMINAL_STATES.has(from)) {
        return err(new DomainErrors_1.TerminalStateError(from));
    }
    const allowed = VALID_TRANSITIONS[from];
    if (!allowed.includes(to)) {
        return err(new DomainErrors_1.InvalidTransitionError(from, to));
    }
    return ok({ from, to });
};
exports.validateTransition = validateTransition;
// ============================================================
// Pure: check if a transition is valid (boolean, no throws)
// ============================================================
const canTransition = (from, to) => {
    if (TERMINAL_STATES.has(from))
        return false;
    return VALID_TRANSITIONS[from].includes(to);
};
exports.canTransition = canTransition;
// ============================================================
// Pure: get all valid next states from a given state
// ============================================================
const getValidNextStates = (from) => VALID_TRANSITIONS[from];
exports.getValidNextStates = getValidNextStates;
// ============================================================
// Pure: check if a state is terminal
// ============================================================
const isTerminalState = (status) => TERMINAL_STATES.has(status);
exports.isTerminalState = isTerminalState;
// ============================================================
// Pure: compute exponential backoff delay
// Formula: min(base * 2^attempt + jitter, maxDelay)
// Jitter prevents thundering herd on retry storms
// ============================================================
const computeBackoffDelay = (attempt, baseDelayMs, maxDelayMs) => {
    const exponential = baseDelayMs * Math.pow(2, attempt);
    const jitter = Math.random() * baseDelayMs * 0.1; // 10% jitter
    return Math.min(exponential + jitter, maxDelayMs);
};
exports.computeBackoffDelay = computeBackoffDelay;
// ============================================================
// Pure: compute next retry time for webhook delivery
// ============================================================
const computeNextRetryAt = (attemptCount, baseDelayMs = 5000) => {
    const delay = (0, exports.computeBackoffDelay)(attemptCount, baseDelayMs, 300000);
    return new Date(Date.now() + delay);
};
exports.computeNextRetryAt = computeNextRetryAt;
// ============================================================
// Pure: determine if a webhook should be retried
// ============================================================
const shouldRetryWebhook = (attemptCount, maxRetries, status) => {
    if (status === 'SUCCESS' || status === 'DEAD')
        return false;
    return attemptCount < maxRetries;
};
exports.shouldRetryWebhook = shouldRetryWebhook;
// ============================================================
// Pure: build a standardized payment event payload
// ============================================================
const buildWebhookPayload = (eventType, transactionId, status, amount, currency, metadata = {}) => Object.freeze({
    event: eventType,
    transactionId,
    status,
    amount,
    currency,
    metadata,
    timestamp: new Date().toISOString(),
    version: '1.0',
});
exports.buildWebhookPayload = buildWebhookPayload;
// ============================================================
// Pure: generate a mock OTP (for simulation)
// In real systems, this would be sent via SMS
// ============================================================
const generateMockOtp = () => String(Math.floor(100000 + Math.random() * 900000));
exports.generateMockOtp = generateMockOtp;
// ============================================================
// Pure: simulate bank payment outcome
// In real systems, this calls the bank/NPCI API
// ============================================================
const simulateBankResponse = (successRate) => {
    const success = Math.random() < successRate;
    return success
        ? {
            success: true,
            bankReferenceId: `BANK_REF_${Date.now()}_${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        }
        : {
            success: false,
            failureReason: 'INSUFFICIENT_BALANCE',
        };
};
exports.simulateBankResponse = simulateBankResponse;
//# sourceMappingURL=StateMachine.js.map