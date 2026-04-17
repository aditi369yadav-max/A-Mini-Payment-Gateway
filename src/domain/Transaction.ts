// ============================================================
// Domain Models — Pure data types, zero side effects
//
// Senior engineer principle: Domain models should be values,
// not objects. They carry data and can be transformed via pure
// functions. Nothing in this file touches DB, Redis, or HTTP.
// ============================================================

export type TransactionStatus =
  | 'INITIATED'
  | 'AUTHENTICATED'
  | 'PROCESSING'
  | 'SUCCESS'
  | 'FAILED'
  | 'RECONCILED';

// Readonly ensures immutability — no accidental mutation
export interface Transaction {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly amount: number;
  readonly currency: string;
  readonly status: TransactionStatus;
  readonly payerUpiId: string;
  readonly payeeUpiId: string;
  readonly merchantId: string;
  readonly description?: string;
  readonly retryCount: number;
  readonly failureReason?: string;
  readonly metadata: Record<string, unknown>;
  readonly otpHash?: string;
  readonly bankReferenceId?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly authenticatedAt?: Date;
  readonly processedAt?: Date;
  readonly reconciledAt?: Date;
}

export interface CreateTransactionInput {
  readonly idempotencyKey: string;
  readonly amount: number;
  readonly currency?: string;
  readonly payerUpiId: string;
  readonly payeeUpiId: string;
  readonly merchantId: string;
  readonly description?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface AuthenticateInput {
  readonly transactionId: string;
  readonly otp: string;
}

export interface WebhookRegistration {
  readonly id: string;
  readonly merchantId: string;
  readonly url: string;
  readonly secret: string;
  readonly isActive: boolean;
  readonly events: string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface WebhookDelivery {
  readonly id: string;
  readonly transactionId: string;
  readonly webhookId: string;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly status: 'PENDING' | 'SUCCESS' | 'FAILED' | 'DEAD';
  readonly attemptCount: number;
  readonly lastAttemptAt?: Date;
  readonly nextRetryAt?: Date;
  readonly responseStatus?: number;
  readonly errorMessage?: string;
  readonly createdAt: Date;
}

export interface StateAuditEntry {
  readonly transactionId: string;
  readonly fromStatus?: TransactionStatus;
  readonly toStatus: TransactionStatus;
  readonly triggeredBy: 'system' | 'user' | 'retry' | 'webhook';
  readonly reason?: string;
  readonly metadata?: Record<string, unknown>;
}

// ============================================================
// Pure helper: create an immutable update of a transaction
// Never mutate — always return a new object
// ============================================================
export const updateTransaction = (
  txn: Transaction,
  updates: Partial<Omit<Transaction, 'id' | 'idempotencyKey' | 'createdAt'>>
): Transaction => Object.freeze({ ...txn, ...updates, updatedAt: new Date() });
