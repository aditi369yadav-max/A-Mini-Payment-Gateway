import { Request, Response, NextFunction } from 'express';
import { IdempotencyCache } from '../../infrastructure/cache/RedisClient';
import { logger } from '../../utils/logger';

// ============================================================
// Idempotency Middleware
//
// Attach to any endpoint that must be idempotent (POST /initiate,
// POST /process, etc.)
//
// Flow:
//   1. Read Idempotency-Key header
//   2. Check Redis for existing response
//   3. If found → return cached response immediately
//   4. If not found → proceed, intercept response, cache it
//
// This is how Stripe implements idempotency — exactly this pattern.
// ============================================================

export const idempotencyMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

  if (!idempotencyKey) {
    res.status(400).json({
      error: 'Missing Idempotency-Key header',
      code:  'MISSING_IDEMPOTENCY_KEY',
    });
    return;
  }

  if (idempotencyKey.length > 255) {
    res.status(400).json({
      error: 'Idempotency-Key must be <= 255 characters',
      code:  'INVALID_IDEMPOTENCY_KEY',
    });
    return;
  }

  // Check cache
  const cached = await IdempotencyCache.get(idempotencyKey);
  if (cached) {
    logger.debug('Idempotency cache hit', { key: idempotencyKey });
    res
      .status(cached.status as number)
      .set('X-Idempotency-Replayed', 'true')
      .json(cached.body);
    return;
  }

  // Attach key to request for downstream use
  req.idempotencyKey = idempotencyKey;

  // Monkey-patch res.json to intercept and cache the response
  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => {
    // Cache the response if status is successful
    if (res.statusCode < 500) {
      IdempotencyCache.setIfAbsent(idempotencyKey, {
        status: res.statusCode,
        body,
      }).catch((err) =>
        logger.error('Failed to cache idempotency response', { error: err })
      );
    }
    return originalJson(body);
  };

  next();
};

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      idempotencyKey?: string;
    }
  }
}
