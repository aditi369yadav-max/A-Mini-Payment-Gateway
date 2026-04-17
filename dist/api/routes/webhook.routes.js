"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.webhookRoutes = void 0;
const express_1 = require("express");
const express_validator_1 = require("express-validator");
const crypto_1 = __importDefault(require("crypto"));
const WebhookRepo_1 = require("../../infrastructure/db/WebhookRepo");
const WebhookSender_1 = require("../../infrastructure/webhook/WebhookSender");
const router = (0, express_1.Router)();
exports.webhookRoutes = router;
const validate = (req, res, next) => {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty()) {
        res.status(400).json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: errors.array() });
        return;
    }
    next();
};
// ============================================================
// POST /api/webhooks/register
// Register a webhook URL for a merchant
//
// Returns a secret — merchant stores this to verify signatures
// ============================================================
router.post('/register', [
    (0, express_validator_1.body)('merchantId').isString().notEmpty().withMessage('merchantId required'),
    (0, express_validator_1.body)('url').isURL().withMessage('url must be a valid URL'),
    (0, express_validator_1.body)('events')
        .optional()
        .isArray()
        .withMessage('events must be an array'),
], validate, async (req, res, next) => {
    try {
        // Generate a signing secret — merchant uses this to verify HMAC signatures
        const secret = crypto_1.default.randomBytes(32).toString('hex');
        const webhook = await WebhookRepo_1.WebhookRepo.register(req.body.merchantId, req.body.url, secret, req.body.events);
        res.status(201).json({
            success: true,
            webhookId: webhook.id,
            merchantId: webhook.merchantId,
            url: webhook.url,
            events: webhook.events,
            secret, // Return ONCE — merchant must store this
            message: 'Webhook registered. Store the secret securely — it will not be shown again.',
            verification: {
                header: 'X-Gateway-Signature',
                algorithm: 'HMAC-SHA256',
                format: 'sha256=<hex_signature>',
                instruction: 'Compute HMAC-SHA256(request_body, secret) and compare with header value',
            },
        });
    }
    catch (error) {
        next(error);
    }
});
// ============================================================
// GET /api/webhooks/merchant/:merchantId
// List all registered webhooks for a merchant
// ============================================================
router.get('/merchant/:merchantId', [(0, express_validator_1.param)('merchantId').isString().notEmpty()], validate, async (req, res, next) => {
    try {
        const webhooks = await WebhookRepo_1.WebhookRepo.findByMerchantId(req.params.merchantId);
        res.status(200).json({
            success: true,
            count: webhooks.length,
            webhooks: webhooks.map(w => ({
                id: w.id,
                url: w.url,
                events: w.events,
                isActive: w.isActive,
                createdAt: w.createdAt,
                // Never return secret in list responses
            })),
        });
    }
    catch (error) {
        next(error);
    }
});
// ============================================================
// POST /api/webhooks/retry
// Manually trigger retry worker (normally runs on cron)
// ============================================================
router.post('/retry', async (_req, res, next) => {
    try {
        await (0, WebhookSender_1.processWebhookRetries)();
        res.status(200).json({
            success: true,
            message: 'Webhook retry worker triggered',
        });
    }
    catch (error) {
        next(error);
    }
});
// ============================================================
// POST /api/webhooks/test
// Simulate a webhook receive endpoint (for local testing)
// Logs the payload — use this as your webhook URL in tests
// ============================================================
router.post('/test/receive', async (req, res) => {
    const signature = req.headers['x-gateway-signature'];
    const timestamp = req.headers['x-gateway-timestamp'];
    console.log('\n========== WEBHOOK RECEIVED ==========');
    console.log('Signature:', signature);
    console.log('Timestamp:', timestamp);
    console.log('Event:', req.body.event);
    console.log('Transaction:', req.body.transactionId);
    console.log('Status:', req.body.status);
    console.log('Payload:', JSON.stringify(req.body, null, 2));
    console.log('======================================\n');
    res.status(200).json({ received: true });
});
//# sourceMappingURL=webhook.routes.js.map