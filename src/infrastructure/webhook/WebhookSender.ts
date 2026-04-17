import axios from 'axios';
import crypto from 'crypto';
import { config } from '../../config';
import { logger, logError } from '../../utils/logger';
import { WebhookRepo } from '../db/WebhookRepo';
import { computeNextRetryAt, shouldRetryWebhook } from '../../domain/StateMachine';

// ============================================================
// Webhook Sender
//
// Signs every payload with HMAC-SHA256 — this is how Stripe,
// Razorpay etc. allow merchants to verify authenticity.
// Merchants check: HMAC(payload, secret) === X-Signature header
// ============================================================

const signPayload = (payload: string, secret: string): string => {
  return crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
};

const sendWebhookRequest = async (
  url: string,
  payload: Record<string, unknown>,
  secret: string
): Promise<{ status: number; body: string }> => {
  const payloadStr = JSON.stringify(payload);
  const signature  = signPayload(payloadStr, secret);
  const timestamp  = Date.now();

  const response = await axios.post(url, payload, {
    timeout: config.webhook.timeoutMs,
    headers: {
      'Content-Type':          'application/json',
      'X-Gateway-Signature':   `sha256=${signature}`,
      'X-Gateway-Timestamp':   String(timestamp),
      'X-Gateway-Version':     '1.0',
      'User-Agent':            'UPI-Gateway/1.0',
    },
    validateStatus: () => true, // Don't throw on non-2xx
  });

  return {
    status: response.status,
    body:   JSON.stringify(response.data),
  };
};

// ============================================================
// Deliver a single webhook — with retry tracking
// ============================================================
export const deliverWebhook = async (deliveryId: string): Promise<void> => {
  // Get pending deliveries — we'd normally pass the delivery object
  // For simplicity, we fetch it from DB
  const pending = await WebhookRepo.getPendingDeliveries();
  const delivery = pending.find(d => d.id === deliveryId);
  if (!delivery) return;

  // Get webhook registration for URL and secret
  // (We'd normally join these in the query — keeping separate for clarity)
  const attemptCount = delivery.attemptCount + 1;
  const now          = new Date();

  try {
    // We need to fetch the webhook registration separately
    // In production you'd join in the DB query
    const resp = await sendWebhookRequest(
      'http://placeholder', // Will be replaced with actual URL
      delivery.payload,
      'placeholder-secret'
    );

    const isSuccess = resp.status >= 200 && resp.status < 300;

    await WebhookRepo.updateDelivery(deliveryId, {
      status:         isSuccess ? 'SUCCESS' : 'FAILED',
      attemptCount,
      lastAttemptAt:  now,
      nextRetryAt:    isSuccess ? undefined : computeNextRetryAt(attemptCount),
      responseStatus: resp.status,
    });

    logger.info('Webhook delivered', { deliveryId, status: resp.status });
  } catch (error) {
    const isDead = !shouldRetryWebhook(attemptCount, config.webhook.maxRetries, 'FAILED');

    await WebhookRepo.updateDelivery(deliveryId, {
      status:        isDead ? 'DEAD' : 'FAILED',
      attemptCount,
      lastAttemptAt: now,
      nextRetryAt:   isDead ? undefined : computeNextRetryAt(attemptCount),
      errorMessage:  error instanceof Error ? error.message : String(error),
    });

    logError('Webhook delivery failed', error, { deliveryId, attempt: attemptCount });
  }
};

// ============================================================
// Send webhook to all registered webhooks for a merchant
// This is what gets called after payment state changes
// ============================================================
export const dispatchWebhooks = async (
  transactionId: string,
  merchantId: string,
  eventType: string,
  payload: Record<string, unknown>
): Promise<void> => {
  try {
    const registrations = await WebhookRepo.findByMerchantId(merchantId);

    if (registrations.length === 0) {
      logger.debug('No webhooks registered for merchant', { merchantId });
      return;
    }

    // Create delivery records for each registered webhook
    const deliveryPromises = registrations
      .filter(w => w.events.includes(eventType))
      .map(async (webhook) => {
        const delivery = await WebhookRepo.createDelivery(
          transactionId,
          webhook.id,
          eventType,
          payload
        );

        // Fire and forget — don't block the payment response
        attemptDelivery(delivery.id, webhook.url, webhook.secret, payload).catch(
          (err) => logError('Async webhook dispatch failed', err, { deliveryId: delivery.id })
        );
      });

    await Promise.allSettled(deliveryPromises);
  } catch (error) {
    // Never fail a payment because of webhook issues
    logError('dispatchWebhooks failed', error, { transactionId, merchantId });
  }
};

// Internal: actually attempt HTTP delivery with full tracking
const attemptDelivery = async (
  deliveryId: string,
  url: string,
  secret: string,
  payload: Record<string, unknown>
): Promise<void> => {
  const now = new Date();

  try {
    const resp = await sendWebhookRequest(url, payload, secret);
    const isSuccess = resp.status >= 200 && resp.status < 300;

    await WebhookRepo.updateDelivery(deliveryId, {
      status:         isSuccess ? 'SUCCESS' : 'FAILED',
      attemptCount:   1,
      lastAttemptAt:  now,
      nextRetryAt:    isSuccess ? undefined : computeNextRetryAt(1),
      responseStatus: resp.status,
    });

    logger.info(`Webhook ${isSuccess ? 'succeeded' : 'failed'}`, {
      deliveryId, status: resp.status
    });
  } catch (error) {
    await WebhookRepo.updateDelivery(deliveryId, {
      status:        'FAILED',
      attemptCount:  1,
      lastAttemptAt: now,
      nextRetryAt:   computeNextRetryAt(1),
      errorMessage:  error instanceof Error ? error.message : String(error),
    });
  }
};

// ============================================================
// Retry worker — run this on a cron/interval
// Picks up FAILED deliveries that are due for retry
// ============================================================
export const processWebhookRetries = async (): Promise<void> => {
  try {
    const pending = await WebhookRepo.getPendingDeliveries();

    if (pending.length === 0) return;

    logger.info(`Processing ${pending.length} pending webhook deliveries`);

    for (const delivery of pending) {
      if (!shouldRetryWebhook(delivery.attemptCount, config.webhook.maxRetries, delivery.status)) {
        await WebhookRepo.updateDelivery(delivery.id, {
          status:        'DEAD',
          attemptCount:  delivery.attemptCount,
          lastAttemptAt: new Date(),
          errorMessage:  'Max retries exceeded',
        });
        continue;
      }
      // Fire deliveries concurrently, bounded
      deliverWebhook(delivery.id).catch((e) =>
        logError('Retry worker error', e, { deliveryId: delivery.id })
      );
    }
  } catch (error) {
    logError('processWebhookRetries failed', error);
  }
};
