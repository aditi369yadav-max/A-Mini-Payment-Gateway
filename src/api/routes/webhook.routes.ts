import { Router, Request, Response, NextFunction } from 'express';
import { body, param, validationResult } from 'express-validator';
import crypto from 'crypto';
import { WebhookRepo } from '../../infrastructure/db/WebhookRepo';
import { processWebhookRetries } from '../../infrastructure/webhook/WebhookSender';

const router = Router();

const validate = (req: Request, res: Response, next: NextFunction): void => {
  const errors = validationResult(req);
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
router.post(
  '/register',
  [
    body('merchantId').isString().notEmpty().withMessage('merchantId required'),
    body('url').isURL().withMessage('url must be a valid URL'),
    body('events')
      .optional()
      .isArray()
      .withMessage('events must be an array'),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Generate a signing secret — merchant uses this to verify HMAC signatures
      const secret = crypto.randomBytes(32).toString('hex');

      const webhook = await WebhookRepo.register(
        req.body.merchantId,
        req.body.url,
        secret,
        req.body.events
      );

      res.status(201).json({
        success:    true,
        webhookId:  webhook.id,
        merchantId: webhook.merchantId,
        url:        webhook.url,
        events:     webhook.events,
        secret,     // Return ONCE — merchant must store this
        message:    'Webhook registered. Store the secret securely — it will not be shown again.',
        verification: {
          header:      'X-Gateway-Signature',
          algorithm:   'HMAC-SHA256',
          format:      'sha256=<hex_signature>',
          instruction: 'Compute HMAC-SHA256(request_body, secret) and compare with header value',
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ============================================================
// GET /api/webhooks/merchant/:merchantId
// List all registered webhooks for a merchant
// ============================================================
router.get(
  '/merchant/:merchantId',
  [param('merchantId').isString().notEmpty()],
  validate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const webhooks = await WebhookRepo.findByMerchantId(req.params.merchantId);

      res.status(200).json({
        success:  true,
        count:    webhooks.length,
        webhooks: webhooks.map(w => ({
          id:        w.id,
          url:       w.url,
          events:    w.events,
          isActive:  w.isActive,
          createdAt: w.createdAt,
          // Never return secret in list responses
        })),
      });
    } catch (error) {
      next(error);
    }
  }
);

// ============================================================
// POST /api/webhooks/retry
// Manually trigger retry worker (normally runs on cron)
// ============================================================
router.post(
  '/retry',
  async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await processWebhookRetries();
      res.status(200).json({
        success: true,
        message: 'Webhook retry worker triggered',
      });
    } catch (error) {
      next(error);
    }
  }
);

// ============================================================
// POST /api/webhooks/test
// Simulate a webhook receive endpoint (for local testing)
// Logs the payload — use this as your webhook URL in tests
// ============================================================
router.post(
  '/test/receive',
  async (req: Request, res: Response): Promise<void> => {
    const signature  = req.headers['x-gateway-signature'];
    const timestamp  = req.headers['x-gateway-timestamp'];

    console.log('\n========== WEBHOOK RECEIVED ==========');
    console.log('Signature:',  signature);
    console.log('Timestamp:',  timestamp);
    console.log('Event:',      req.body.event);
    console.log('Transaction:', req.body.transactionId);
    console.log('Status:',     req.body.status);
    console.log('Payload:',    JSON.stringify(req.body, null, 2));
    console.log('======================================\n');

    res.status(200).json({ received: true });
  }
);

export { router as webhookRoutes };
