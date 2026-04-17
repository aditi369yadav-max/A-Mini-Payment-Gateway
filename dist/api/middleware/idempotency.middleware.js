"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.idempotencyMiddleware = void 0;
const RedisClient_1 = require("../../infrastructure/cache/RedisClient");
const logger_1 = require("../../utils/logger");
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
const idempotencyMiddleware = async (req, res, next) => {
    const idempotencyKey = req.headers['idempotency-key'];
    if (!idempotencyKey) {
        res.status(400).json({
            error: 'Missing Idempotency-Key header',
            code: 'MISSING_IDEMPOTENCY_KEY',
        });
        return;
    }
    if (idempotencyKey.length > 255) {
        res.status(400).json({
            error: 'Idempotency-Key must be <= 255 characters',
            code: 'INVALID_IDEMPOTENCY_KEY',
        });
        return;
    }
    // Check cache
    const cached = await RedisClient_1.IdempotencyCache.get(idempotencyKey);
    if (cached) {
        logger_1.logger.debug('Idempotency cache hit', { key: idempotencyKey });
        res
            .status(cached.status)
            .set('X-Idempotency-Replayed', 'true')
            .json(cached.body);
        return;
    }
    // Attach key to request for downstream use
    req.idempotencyKey = idempotencyKey;
    // Monkey-patch res.json to intercept and cache the response
    const originalJson = res.json.bind(res);
    res.json = (body) => {
        // Cache the response if status is successful
        if (res.statusCode < 500) {
            RedisClient_1.IdempotencyCache.setIfAbsent(idempotencyKey, {
                status: res.statusCode,
                body,
            }).catch((err) => logger_1.logger.error('Failed to cache idempotency response', { error: err }));
        }
        return originalJson(body);
    };
    next();
};
exports.idempotencyMiddleware = idempotencyMiddleware;
//# sourceMappingURL=idempotency.middleware.js.map