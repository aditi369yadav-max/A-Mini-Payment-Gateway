"use strict";
// ============================================================
// Typed Error Hierarchy
// Never throw raw Error objects — always use typed domain errors.
// This allows callers to pattern-match on error type and respond
// with the correct HTTP status / message without ugly string checks.
// ============================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.ValidationError = exports.TerminalStateError = exports.InvalidOTPError = exports.IdempotencyConflictError = exports.TransactionNotFoundError = exports.InvalidTransitionError = exports.DomainError = void 0;
class DomainError extends Error {
    constructor(code, message, httpStatus = 400, details) {
        super(message);
        this.code = code;
        this.httpStatus = httpStatus;
        this.details = details;
        this.name = 'DomainError';
        // Proper prototype chain for instanceof checks
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
exports.DomainError = DomainError;
class InvalidTransitionError extends DomainError {
    constructor(from, to) {
        super('INVALID_TRANSITION', `Invalid state transition: ${from} → ${to}`, 422);
        this.name = 'InvalidTransitionError';
    }
}
exports.InvalidTransitionError = InvalidTransitionError;
class TransactionNotFoundError extends DomainError {
    constructor(id) {
        super('TRANSACTION_NOT_FOUND', `Transaction not found: ${id}`, 404);
        this.name = 'TransactionNotFoundError';
    }
}
exports.TransactionNotFoundError = TransactionNotFoundError;
class IdempotencyConflictError extends DomainError {
    constructor(key) {
        super('IDEMPOTENCY_CONFLICT', `Idempotency key already used: ${key}`, 409);
        this.name = 'IdempotencyConflictError';
    }
}
exports.IdempotencyConflictError = IdempotencyConflictError;
class InvalidOTPError extends DomainError {
    constructor() {
        super('INVALID_OTP', 'Invalid or expired OTP', 401);
        this.name = 'InvalidOTPError';
    }
}
exports.InvalidOTPError = InvalidOTPError;
class TerminalStateError extends DomainError {
    constructor(status) {
        super('TERMINAL_STATE', `Transaction is in terminal state: ${status}. No further transitions allowed.`, 422);
        this.name = 'TerminalStateError';
    }
}
exports.TerminalStateError = TerminalStateError;
class ValidationError extends DomainError {
    constructor(message, details) {
        super('VALIDATION_ERROR', message, 400, details);
        this.name = 'ValidationError';
    }
}
exports.ValidationError = ValidationError;
//# sourceMappingURL=DomainErrors.js.map