"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.processWebhookRetries = exports.dispatchWebhooks = exports.deliverWebhook = void 0;
const axios_1 = __importDefault(require("axios"));
const crypto_1 = __importDefault(require("crypto"));
const config_1 = require("../../config");
const logger_1 = require("../../utils/logger");
const WebhookRepo_1 = require("../db/WebhookRepo");
const StateMachine_1 = require("../../domain/StateMachine");
// ============================================================
// Webhook Sender
//
// Signs every payload with HMAC-SHA256 — this is how Stripe,
// Razorpay etc. allow merchants to verify authenticity.
// Merchants check: HMAC(payload, secret) === X-Signature header
// ============================================================
const signPayload = (payload, secret) => {
    return crypto_1.default
        .createHmac('sha256', secret)
        .update(payload)
        .digest('hex');
};
const sendWebhookRequest = async (url, payload, secret) => {
    const payloadStr = JSON.stringify(payload);
    const signature = signPayload(payloadStr, secret);
    const timestamp = Date.now();
    const response = await axios_1.default.post(url, payload, {
        timeout: config_1.config.webhook.timeoutMs,
        headers: {
            'Content-Type': 'application/json',
            'X-Gateway-Signature': `sha256=${signature}`,
            'X-Gateway-Timestamp': String(timestamp),
            'X-Gateway-Version': '1.0',
            'User-Agent': 'UPI-Gateway/1.0',
        },
        validateStatus: () => true, // Don't throw on non-2xx
    });
    return {
        status: response.status,
        body: JSON.stringify(response.data),
    };
};
// ============================================================
// Deliver a single webhook — with retry tracking
// ============================================================
const deliverWebhook = async (deliveryId) => {
    // Get pending deliveries — we'd normally pass the delivery object
    // For simplicity, we fetch it from DB
    const pending = await WebhookRepo_1.WebhookRepo.getPendingDeliveries();
    const delivery = pending.find(d => d.id === deliveryId);
    if (!delivery)
        return;
    // Get webhook registration for URL and secret
    // (We'd normally join these in the query — keeping separate for clarity)
    const attemptCount = delivery.attemptCount + 1;
    const now = new Date();
    try {
        // We need to fetch the webhook registration separately
        // In production you'd join in the DB query
        const resp = await sendWebhookRequest('http://placeholder', // Will be replaced with actual URL
        delivery.payload, 'placeholder-secret');
        const isSuccess = resp.status >= 200 && resp.status < 300;
        await WebhookRepo_1.WebhookRepo.updateDelivery(deliveryId, {
            status: isSuccess ? 'SUCCESS' : 'FAILED',
            attemptCount,
            lastAttemptAt: now,
            nextRetryAt: isSuccess ? undefined : (0, StateMachine_1.computeNextRetryAt)(attemptCount),
            responseStatus: resp.status,
        });
        logger_1.logger.info('Webhook delivered', { deliveryId, status: resp.status });
    }
    catch (error) {
        const isDead = !(0, StateMachine_1.shouldRetryWebhook)(attemptCount, config_1.config.webhook.maxRetries, 'FAILED');
        await WebhookRepo_1.WebhookRepo.updateDelivery(deliveryId, {
            status: isDead ? 'DEAD' : 'FAILED',
            attemptCount,
            lastAttemptAt: now,
            nextRetryAt: isDead ? undefined : (0, StateMachine_1.computeNextRetryAt)(attemptCount),
            errorMessage: error instanceof Error ? error.message : String(error),
        });
        (0, logger_1.logError)('Webhook delivery failed', error, { deliveryId, attempt: attemptCount });
    }
};
exports.deliverWebhook = deliverWebhook;
// ============================================================
// Send webhook to all registered webhooks for a merchant
// This is what gets called after payment state changes
// ============================================================
const dispatchWebhooks = async (transactionId, merchantId, eventType, payload) => {
    try {
        const registrations = await WebhookRepo_1.WebhookRepo.findByMerchantId(merchantId);
        if (registrations.length === 0) {
            logger_1.logger.debug('No webhooks registered for merchant', { merchantId });
            return;
        }
        // Create delivery records for each registered webhook
        const deliveryPromises = registrations
            .filter(w => w.events.includes(eventType))
            .map(async (webhook) => {
            const delivery = await WebhookRepo_1.WebhookRepo.createDelivery(transactionId, webhook.id, eventType, payload);
            // Fire and forget — don't block the payment response
            attemptDelivery(delivery.id, webhook.url, webhook.secret, payload).catch((err) => (0, logger_1.logError)('Async webhook dispatch failed', err, { deliveryId: delivery.id }));
        });
        await Promise.allSettled(deliveryPromises);
    }
    catch (error) {
        // Never fail a payment because of webhook issues
        (0, logger_1.logError)('dispatchWebhooks failed', error, { transactionId, merchantId });
    }
};
exports.dispatchWebhooks = dispatchWebhooks;
// Internal: actually attempt HTTP delivery with full tracking
const attemptDelivery = async (deliveryId, url, secret, payload) => {
    const now = new Date();
    try {
        const resp = await sendWebhookRequest(url, payload, secret);
        const isSuccess = resp.status >= 200 && resp.status < 300;
        await WebhookRepo_1.WebhookRepo.updateDelivery(deliveryId, {
            status: isSuccess ? 'SUCCESS' : 'FAILED',
            attemptCount: 1,
            lastAttemptAt: now,
            nextRetryAt: isSuccess ? undefined : (0, StateMachine_1.computeNextRetryAt)(1),
            responseStatus: resp.status,
        });
        logger_1.logger.info(`Webhook ${isSuccess ? 'succeeded' : 'failed'}`, {
            deliveryId, status: resp.status
        });
    }
    catch (error) {
        await WebhookRepo_1.WebhookRepo.updateDelivery(deliveryId, {
            status: 'FAILED',
            attemptCount: 1,
            lastAttemptAt: now,
            nextRetryAt: (0, StateMachine_1.computeNextRetryAt)(1),
            errorMessage: error instanceof Error ? error.message : String(error),
        });
    }
};
// ============================================================
// Retry worker — run this on a cron/interval
// Picks up FAILED deliveries that are due for retry
// ============================================================
const processWebhookRetries = async () => {
    try {
        const pending = await WebhookRepo_1.WebhookRepo.getPendingDeliveries();
        if (pending.length === 0)
            return;
        logger_1.logger.info(`Processing ${pending.length} pending webhook deliveries`);
        for (const delivery of pending) {
            if (!(0, StateMachine_1.shouldRetryWebhook)(delivery.attemptCount, config_1.config.webhook.maxRetries, delivery.status)) {
                await WebhookRepo_1.WebhookRepo.updateDelivery(delivery.id, {
                    status: 'DEAD',
                    attemptCount: delivery.attemptCount,
                    lastAttemptAt: new Date(),
                    errorMessage: 'Max retries exceeded',
                });
                continue;
            }
            // Fire deliveries concurrently, bounded
            (0, exports.deliverWebhook)(delivery.id).catch((e) => (0, logger_1.logError)('Retry worker error', e, { deliveryId: delivery.id }));
        }
    }
    catch (error) {
        (0, logger_1.logError)('processWebhookRetries failed', error);
    }
};
exports.processWebhookRetries = processWebhookRetries;
//# sourceMappingURL=WebhookSender.js.map