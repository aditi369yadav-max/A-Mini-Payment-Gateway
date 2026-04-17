import { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { Transaction, CreateTransactionInput, StateAuditEntry, TransactionStatus } from '../../domain/Transaction';
import { withTransaction, queryOne, query, getPool } from './postgres';
import { TransactionNotFoundError } from '../../domain/errors/DomainErrors';
import { logger } from '../../utils/logger';

// ============================================================
// Row mappers — DB rows use snake_case, domain uses camelCase
// Always map at the boundary — never let snake_case leak into
// business logic
// ============================================================
const mapRowToTransaction = (row: Record<string, unknown>): Transaction => ({
  id:                row.id as string,
  idempotencyKey:    row.idempotency_key as string,
  amount:            parseFloat(row.amount as string),
  currency:          row.currency as string,
  status:            row.status as TransactionStatus,
  payerUpiId:        row.payer_upi_id as string,
  payeeUpiId:        row.payee_upi_id as string,
  merchantId:        row.merchant_id as string,
  description:       row.description as string | undefined,
  retryCount:        row.retry_count as number,
  failureReason:     row.failure_reason as string | undefined,
  metadata:          (row.metadata as Record<string, unknown>) ?? {},
  otpHash:           row.otp_hash as string | undefined,
  bankReferenceId:   row.bank_reference_id as string | undefined,
  createdAt:         row.created_at as Date,
  updatedAt:         row.updated_at as Date,
  authenticatedAt:   row.authenticated_at as Date | undefined,
  processedAt:       row.processed_at as Date | undefined,
  reconciledAt:      row.reconciled_at as Date | undefined,
});

export const TransactionRepo = {
  // ============================================================
  // Create a new transaction — wrapped in DB transaction
  // ============================================================
  async create(input: CreateTransactionInput): Promise<Transaction> {
    const id = uuidv4();
    const sql = `
      INSERT INTO transactions (
        id, idempotency_key, amount, currency,
        payer_upi_id, payee_upi_id, merchant_id,
        description, metadata, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'INITIATED')
      RETURNING *
    `;
    const params = [
      id,
      input.idempotencyKey,
      input.amount,
      input.currency ?? 'INR',
      input.payerUpiId,
      input.payeeUpiId,
      input.merchantId,
      input.description ?? null,
      JSON.stringify(input.metadata ?? {}),
    ];

    const row = await queryOne<Record<string, unknown>>(sql, params);
    if (!row) throw new Error('Failed to create transaction');

    logger.info('Transaction created', { transactionId: id });
    return mapRowToTransaction(row);
  },

  // ============================================================
  // Find by ID — uses Redis cache first (handled in service layer)
  // ============================================================
  async findById(id: string): Promise<Transaction | null> {
    const row = await queryOne<Record<string, unknown>>(
      'SELECT * FROM transactions WHERE id = $1',
      [id]
    );
    return row ? mapRowToTransaction(row) : null;
  },

  async findByIdOrThrow(id: string): Promise<Transaction> {
    const txn = await this.findById(id);
    if (!txn) throw new TransactionNotFoundError(id);
    return txn;
  },

  async findByIdempotencyKey(key: string): Promise<Transaction | null> {
    const row = await queryOne<Record<string, unknown>>(
      'SELECT * FROM transactions WHERE idempotency_key = $1',
      [key]
    );
    return row ? mapRowToTransaction(row) : null;
  },

  // ============================================================
  // Transition status — always wrapped in a DB transaction
  // Writes audit log in the SAME DB transaction (atomically)
  // ============================================================
  async transitionStatus(
    id: string,
    toStatus: TransactionStatus,
    updates: {
      failureReason?: string;
      bankReferenceId?: string;
      otpHash?: string;
      retryCount?: number;
    },
    auditEntry: StateAuditEntry
  ): Promise<Transaction> {
    return withTransaction(async (client: PoolClient) => {
      // Lock the row for this transaction to prevent races
      const lockResult = await client.query(
        'SELECT * FROM transactions WHERE id = $1 FOR UPDATE',
        [id]
      );

      if (lockResult.rows.length === 0) {
        throw new TransactionNotFoundError(id);
      }

      const timestampField = toStatus === 'AUTHENTICATED' ? 'authenticated_at'
        : toStatus === 'SUCCESS' || toStatus === 'FAILED' ? 'processed_at'
        : toStatus === 'RECONCILED' ? 'reconciled_at'
        : null;

      const updateSql = `
        UPDATE transactions SET
          status            = $1,
          failure_reason    = COALESCE($2, failure_reason),
          bank_reference_id = COALESCE($3, bank_reference_id),
          otp_hash          = COALESCE($4, otp_hash),
          retry_count       = COALESCE($5, retry_count),
          ${timestampField ? `${timestampField} = NOW(),` : ''}
          updated_at        = NOW()
        WHERE id = $6
        RETURNING *
      `;

      const updateResult = await client.query(updateSql, [
        toStatus,
        updates.failureReason ?? null,
        updates.bankReferenceId ?? null,
        updates.otpHash ?? null,
        updates.retryCount ?? null,
        id,
      ]);

      // Write immutable audit entry in the same transaction
      await client.query(
        `INSERT INTO transaction_state_audit
           (transaction_id, from_status, to_status, triggered_by, reason, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          id,
          auditEntry.fromStatus ?? null,
          auditEntry.toStatus,
          auditEntry.triggeredBy,
          auditEntry.reason ?? null,
          JSON.stringify(auditEntry.metadata ?? {}),
        ]
      );

      return mapRowToTransaction(updateResult.rows[0]);
    });
  },

  async getAuditLog(transactionId: string): Promise<unknown[]> {
    return query(
      `SELECT * FROM transaction_state_audit
       WHERE transaction_id = $1
       ORDER BY created_at ASC`,
      [transactionId]
    );
  },

  async logRetry(
    transactionId: string,
    attemptNumber: number,
    delayMs: number,
    reason: string,
    outcome: 'SUCCESS' | 'FAILED' | 'SCHEDULED'
  ): Promise<void> {
    await getPool().query(
      `INSERT INTO retry_logs (transaction_id, attempt_number, delay_ms, reason, outcome)
       VALUES ($1, $2, $3, $4, $5)`,
      [transactionId, attemptNumber, delayMs, reason, outcome]
    );
  },
};
