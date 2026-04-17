"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebhookRepo = void 0;
const uuid_1 = require("uuid");
const postgres_1 = require("./postgres");
const mapWebhookRow = (row) => ({
    id: row.id,
    merchantId: row.merchant_id,
    url: row.url,
    secret: row.secret,
    isActive: row.is_active,
    events: row.events,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
});
const mapDeliveryRow = (row) => ({
    id: row.id,
    transactionId: row.transaction_id,
    webhookId: row.webhook_id,
    eventType: row.event_type,
    payload: row.payload,
    status: row.status,
    attemptCount: row.attempt_count,
    lastAttemptAt: row.last_attempt_at,
    nextRetryAt: row.next_retry_at,
    responseStatus: row.response_status,
    errorMessage: row.error_message,
    createdAt: row.created_at,
});
exports.WebhookRepo = {
    async register(merchantId, url, secret, events) {
        const id = (0, uuid_1.v4)();
        const row = await (0, postgres_1.queryOne)(`INSERT INTO webhook_registrations (id, merchant_id, url, secret, events)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`, [id, merchantId, url, secret, events ?? ['PAYMENT_SUCCESS', 'PAYMENT_FAILED', 'PAYMENT_RECONCILED']]);
        if (!row)
            throw new Error('Failed to register webhook');
        return mapWebhookRow(row);
    },
    async findByMerchantId(merchantId) {
        const rows = await (0, postgres_1.query)('SELECT * FROM webhook_registrations WHERE merchant_id = $1 AND is_active = TRUE', [merchantId]);
        return rows.map(mapWebhookRow);
    },
    async createDelivery(transactionId, webhookId, eventType, payload) {
        const id = (0, uuid_1.v4)();
        const row = await (0, postgres_1.queryOne)(`INSERT INTO webhook_deliveries (id, transaction_id, webhook_id, event_type, payload)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`, [id, transactionId, webhookId, eventType, JSON.stringify(payload)]);
        if (!row)
            throw new Error('Failed to create webhook delivery');
        return mapDeliveryRow(row);
    },
    async updateDelivery(id, update) {
        await (0, postgres_1.getPool)().query(`UPDATE webhook_deliveries SET
         status = $1, attempt_count = $2,
         last_attempt_at = $3, next_retry_at = $4,
         response_status = $5, error_message = $6
       WHERE id = $7`, [
            update.status,
            update.attemptCount,
            update.lastAttemptAt,
            update.nextRetryAt ?? null,
            update.responseStatus ?? null,
            update.errorMessage ?? null,
            id,
        ]);
    },
    async getPendingDeliveries() {
        const rows = await (0, postgres_1.query)(`SELECT * FROM webhook_deliveries
       WHERE status = 'PENDING' AND next_retry_at <= NOW()
       ORDER BY next_retry_at ASC
       LIMIT 50`);
        return rows.map(mapDeliveryRow);
    },
};
//# sourceMappingURL=WebhookRepo.js.map