// ============================================================
// Typed Error Hierarchy
// Never throw raw Error objects — always use typed domain errors.
// This allows callers to pattern-match on error type and respond
// with the correct HTTP status / message without ugly string checks.
// ============================================================

export type ErrorCode =
  | 'INVALID_TRANSITION'
  | 'TRANSACTION_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'DUPLICATE_TRANSACTION'
  | 'INVALID_OTP'
  | 'PAYMENT_PROCESSING_FAILED'
  | 'WEBHOOK_DELIVERY_FAILED'
  | 'VALIDATION_ERROR'
  | 'TERMINAL_STATE'
  | 'INTERNAL_ERROR';

export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly httpStatus: number = 400,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'DomainError';
    // Proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InvalidTransitionError extends DomainError {
  constructor(from: string, to: string) {
    super(
      'INVALID_TRANSITION',
      `Invalid state transition: ${from} → ${to}`,
      422
    );
    this.name = 'InvalidTransitionError';
  }
}

export class TransactionNotFoundError extends DomainError {
  constructor(id: string) {
    super('TRANSACTION_NOT_FOUND', `Transaction not found: ${id}`, 404);
    this.name = 'TransactionNotFoundError';
  }
}

export class IdempotencyConflictError extends DomainError {
  constructor(key: string) {
    super(
      'IDEMPOTENCY_CONFLICT',
      `Idempotency key already used: ${key}`,
      409
    );
    this.name = 'IdempotencyConflictError';
  }
}

export class InvalidOTPError extends DomainError {
  constructor() {
    super('INVALID_OTP', 'Invalid or expired OTP', 401);
    this.name = 'InvalidOTPError';
  }
}

export class TerminalStateError extends DomainError {
  constructor(status: string) {
    super(
      'TERMINAL_STATE',
      `Transaction is in terminal state: ${status}. No further transitions allowed.`,
      422
    );
    this.name = 'TerminalStateError';
  }
}

export class ValidationError extends DomainError {
  constructor(message: string, details?: unknown) {
    super('VALIDATION_ERROR', message, 400, details);
    this.name = 'ValidationError';
  }
}
