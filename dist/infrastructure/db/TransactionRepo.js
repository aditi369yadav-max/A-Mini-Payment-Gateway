"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TransactionRepo = void 0;
const uuid_1 = require("uuid");
const postgres_1 = require("./postgres");
const DomainErrors_1 = require("../../domain/errors/DomainErrors");
const logger_1 = require("../../utils/logger");
// ============================================================
// Row mappers — DB rows use snake_case, domain uses camelCase
// Always map at the boundary — never let snake_case leak into
// business logic
// ============================================================
const mapRowToTransaction = (row) => ({
    id: row.id,
    idempotencyKey: row.idempotency_key,
    amount: parseFloat(row.amount),
    currency: row.currency,
    status: row.status,
    payerUpiId: row.payer_upi_id,
    payeeUpiId: row.payee_upi_id,
    merchantId: row.merchant_id,
    description: row.description,
    retryCount: row.retry_count,
    failureReason: row.failure_reason,
    metadata: row.metadata ?? {},
    otpHash: row.otp_hash,
    bankReferenceId: row.bank_reference_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    authenticatedAt: row.authenticated_at,
    processedAt: row.processed_at,
    reconciledAt: row.reconciled_at,
});
exports.TransactionRepo = {
    // ============================================================
    // Create a new transaction — wrapped in DB transaction
    // ============================================================
    async create(input) {
        const id = (0, uuid_1.v4)();
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
        const row = await (0, postgres_1.queryOne)(sql, params);
        if (!row)
            throw new Error('Failed to create transaction');
        logger_1.logger.info('Transaction created', { transactionId: id });
        return mapRowToTransaction(row);
    },
    // ============================================================
    // Find by ID — uses Redis cache first (handled in service layer)
    // ============================================================
    async findById(id) {
        const row = await (0, postgres_1.queryOne)('SELECT * FROM transactions WHERE id = $1', [id]);
        return row ? mapRowToTransaction(row) : null;
    },
    async findByIdOrThrow(id) {
        const txn = await this.findById(id);
        if (!txn)
            throw new DomainErrors_1.TransactionNotFoundError(id);
        return txn;
    },
    async findByIdempotencyKey(key) {
        const row = await (0, postgres_1.queryOne)('SELECT * FROM transactions WHERE idempotency_key = $1', [key]);
        return row ? mapRowToTransaction(row) : null;
    },
    // ============================================================
    // Transition status — always wrapped in a DB transaction
    // Writes audit log in the SAME DB transaction (atomically)
    // ============================================================
    async transitionStatus(id, toStatus, updates, auditEntry) {
        return (0, postgres_1.withTransaction)(async (client) => {
            // Lock the row for this transaction to prevent races
            const lockResult = await client.query('SELECT * FROM transactions WHERE id = $1 FOR UPDATE', [id]);
            if (lockResult.rows.length === 0) {
                throw new DomainErrors_1.TransactionNotFoundError(id);
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
            await client.query(`INSERT INTO transaction_state_audit
           (transaction_id, from_status, to_status, triggered_by, reason, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`, [
                id,
                auditEntry.fromStatus ?? null,
                auditEntry.toStatus,
                auditEntry.triggeredBy,
                auditEntry.reason ?? null,
                JSON.stringify(auditEntry.metadata ?? {}),
            ]);
            return mapRowToTransaction(updateResult.rows[0]);
        });
    },
    async getAuditLog(transactionId) {
        return (0, postgres_1.query)(`SELECT * FROM transaction_state_audit
       WHERE transaction_id = $1
       ORDER BY created_at ASC`, [transactionId]);
    },
    async logRetry(transactionId, attemptNumber, delayMs, reason, outcome) {
        await (0, postgres_1.getPool)().query(`INSERT INTO retry_logs (transaction_id, attempt_number, delay_ms, reason, outcome)
       VALUES ($1, $2, $3, $4, $5)`, [transactionId, attemptNumber, delayMs, reason, outcome]);
    },
};
//# sourceMappingURL=TransactionRepo.js.map