import { v4 as uuidv4 } from 'uuid';
import { WebhookRegistration, WebhookDelivery } from '../../domain/Transaction';
import { query, queryOne, getPool } from './postgres';

const mapWebhookRow = (row: Record<string, unknown>): WebhookRegistration => ({
  id:         row.id as string,
  merchantId: row.merchant_id as string,
  url:        row.url as string,
  secret:     row.secret as string,
  isActive:   row.is_active as boolean,
  events:     row.events as string[],
  createdAt:  row.created_at as Date,
  updatedAt:  row.updated_at as Date,
});

const mapDeliveryRow = (row: Record<string, unknown>): WebhookDelivery => ({
  id:             row.id as string,
  transactionId:  row.transaction_id as string,
  webhookId:      row.webhook_id as string,
  eventType:      row.event_type as string,
  payload:        row.payload as Record<string, unknown>,
  status:         row.status as WebhookDelivery['status'],
  attemptCount:   row.attempt_count as number,
  lastAttemptAt:  row.last_attempt_at as Date | undefined,
  nextRetryAt:    row.next_retry_at as Date | undefined,
  responseStatus: row.response_status as number | undefined,
  errorMessage:   row.error_message as string | undefined,
  createdAt:      row.created_at as Date,
});

export const WebhookRepo = {
  async register(
    merchantId: string,
    url: string,
    secret: string,
    events?: string[]
  ): Promise<WebhookRegistration> {
    const id = uuidv4();
    const row = await queryOne<Record<string, unknown>>(
      `INSERT INTO webhook_registrations (id, merchant_id, url, secret, events)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, merchantId, url, secret, events ?? ['PAYMENT_SUCCESS', 'PAYMENT_FAILED', 'PAYMENT_RECONCILED']]
    );
    if (!row) throw new Error('Failed to register webhook');
    return mapWebhookRow(row);
  },

  async findByMerchantId(merchantId: string): Promise<WebhookRegistration[]> {
    const rows = await query<Record<string, unknown>>(
      'SELECT * FROM webhook_registrations WHERE merchant_id = $1 AND is_active = TRUE',
      [merchantId]
    );
    return rows.map(mapWebhookRow);
  },

  async createDelivery(
    transactionId: string,
    webhookId: string,
    eventType: string,
    payload: Record<string, unknown>
  ): Promise<WebhookDelivery> {
    const id = uuidv4();
    const row = await queryOne<Record<string, unknown>>(
      `INSERT INTO webhook_deliveries (id, transaction_id, webhook_id, event_type, payload)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, transactionId, webhookId, eventType, JSON.stringify(payload)]
    );
    if (!row) throw new Error('Failed to create webhook delivery');
    return mapDeliveryRow(row);
  },

  async updateDelivery(
    id: string,
    update: {
      status: string;
      attemptCount: number;
      lastAttemptAt: Date;
      nextRetryAt?: Date;
      responseStatus?: number;
      responseBody?: string;
      errorMessage?: string;
    }
  ): Promise<void> {
    await getPool().query(
      `UPDATE webhook_deliveries SET
         status = $1, attempt_count = $2,
         last_attempt_at = $3, next_retry_at = $4,
         response_status = $5, error_message = $6
       WHERE id = $7`,
      [
        update.status,
        update.attemptCount,
        update.lastAttemptAt,
        update.nextRetryAt ?? null,
        update.responseStatus ?? null,
        update.errorMessage ?? null,
        id,
      ]
    );
  },

  async getPendingDeliveries(): Promise<WebhookDelivery[]> {
    const rows = await query<Record<string, unknown>>(
      `SELECT * FROM webhook_deliveries
       WHERE status = 'PENDING' AND next_retry_at <= NOW()
       ORDER BY next_retry_at ASC
       LIMIT 50`,
    );
    return rows.map(mapDeliveryRow);
  },
};
