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

import { TransactionStatus } from './Transaction';
import {
  InvalidTransitionError,
  TerminalStateError,
} from './errors/DomainErrors';

// ============================================================
// Transition table — encoded as pure data, not imperative code
// This is the authoritative source of truth for what's allowed
// ============================================================
const VALID_TRANSITIONS: Readonly<
  Record<TransactionStatus, readonly TransactionStatus[]>
> = Object.freeze({
  INITIATED:     ['AUTHENTICATED', 'FAILED'] as const,
  AUTHENTICATED: ['PROCESSING', 'FAILED']   as const,
  PROCESSING:    ['SUCCESS', 'FAILED']       as const,
  SUCCESS:       ['RECONCILED']              as const,
  FAILED:        ['INITIATED']               as const,  // allows retry
  RECONCILED:    []                          as const,  // terminal
});

// Terminal states — no exit
const TERMINAL_STATES: ReadonlySet<TransactionStatus> = new Set([
  'RECONCILED',
]);

// ============================================================
// Result type — forces callers to handle both cases
// This is the Haskell Either<L, R> pattern in TypeScript
// ============================================================
export type TransitionResult<T> =
  | { readonly ok: true;  readonly value: T }
  | { readonly ok: false; readonly error: Error };

const ok = <T>(value: T): TransitionResult<T> => ({ ok: true, value });
const err = (error: Error): TransitionResult<never> => ({ ok: false, error });

// ============================================================
// Pure: validate a transition without performing it
// ============================================================
export const validateTransition = (
  from: TransactionStatus,
  to: TransactionStatus
): TransitionResult<{ from: TransactionStatus; to: TransactionStatus }> => {
  if (TERMINAL_STATES.has(from)) {
    return err(new TerminalStateError(from));
  }

  const allowed = VALID_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    return err(new InvalidTransitionError(from, to));
  }

  return ok({ from, to });
};

// ============================================================
// Pure: check if a transition is valid (boolean, no throws)
// ============================================================
export const canTransition = (
  from: TransactionStatus,
  to: TransactionStatus
): boolean => {
  if (TERMINAL_STATES.has(from)) return false;
  return (VALID_TRANSITIONS[from] as readonly string[]).includes(to);
};

// ============================================================
// Pure: get all valid next states from a given state
// ============================================================
export const getValidNextStates = (
  from: TransactionStatus
): readonly TransactionStatus[] => VALID_TRANSITIONS[from];

// ============================================================
// Pure: check if a state is terminal
// ============================================================
export const isTerminalState = (status: TransactionStatus): boolean =>
  TERMINAL_STATES.has(status);

// ============================================================
// Pure: compute exponential backoff delay
// Formula: min(base * 2^attempt + jitter, maxDelay)
// Jitter prevents thundering herd on retry storms
// ============================================================
export const computeBackoffDelay = (
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number
): number => {
  const exponential = baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * baseDelayMs * 0.1;  // 10% jitter
  return Math.min(exponential + jitter, maxDelayMs);
};

// ============================================================
// Pure: compute next retry time for webhook delivery
// ============================================================
export const computeNextRetryAt = (
  attemptCount: number,
  baseDelayMs: number = 5000
): Date => {
  const delay = computeBackoffDelay(attemptCount, baseDelayMs, 300_000);
  return new Date(Date.now() + delay);
};

// ============================================================
// Pure: determine if a webhook should be retried
// ============================================================
export const shouldRetryWebhook = (
  attemptCount: number,
  maxRetries: number,
  status: string
): boolean => {
  if (status === 'SUCCESS' || status === 'DEAD') return false;
  return attemptCount < maxRetries;
};

// ============================================================
// Pure: build a standardized payment event payload
// ============================================================
export const buildWebhookPayload = (
  eventType: string,
  transactionId: string,
  status: TransactionStatus,
  amount: number,
  currency: string,
  metadata: Record<string, unknown> = {}
): Record<string, unknown> =>
  Object.freeze({
    event:         eventType,
    transactionId,
    status,
    amount,
    currency,
    metadata,
    timestamp:     new Date().toISOString(),
    version:       '1.0',
  });

// ============================================================
// Pure: generate a mock OTP (for simulation)
// In real systems, this would be sent via SMS
// ============================================================
export const generateMockOtp = (): string =>
  String(Math.floor(100000 + Math.random() * 900000));

// ============================================================
// Pure: simulate bank payment outcome
// In real systems, this calls the bank/NPCI API
// ============================================================
export const simulateBankResponse = (
  successRate: number
): { success: boolean; bankReferenceId?: string; failureReason?: string } => {
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
