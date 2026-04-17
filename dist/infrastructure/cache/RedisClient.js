"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.closeRedis = exports.DistributedLock = exports.OTPStore = exports.TransactionCache = exports.IdempotencyCache = exports.getRedis = void 0;
const ioredis_1 = __importDefault(require("ioredis"));
const config_1 = require("../../config");
const logger_1 = require("../../utils/logger");
let redisClient = null;
const getRedis = () => {
    if (!redisClient) {
        if (process.env.REDIS_URL) {
            redisClient = new ioredis_1.default(process.env.REDIS_URL, {
                retryStrategy: (times) => Math.min(times * 100, 3000),
            });
        }
        else {
            redisClient = new ioredis_1.default({
                host: config_1.config.redis.host,
                port: config_1.config.redis.port,
                password: config_1.config.redis.password || undefined,
                db: config_1.config.redis.db,
                retryStrategy: (times) => Math.min(times * 100, 3000),
                lazyConnect: true,
            });
        }
        redisClient.on('connect', () => logger_1.logger.info('Redis connected'));
        redisClient.on('error', (err) => logger_1.logger.error('Redis error', { error: err.message }));
        redisClient.on('reconnecting', () => logger_1.logger.warn('Redis reconnecting'));
    }
    return redisClient;
};
exports.getRedis = getRedis;
exports.IdempotencyCache = {
    async get(key) {
        const redis = (0, exports.getRedis)();
        const raw = await redis.get(`idem:${key}`);
        if (!raw)
            return null;
        try {
            return JSON.parse(raw);
        }
        catch {
            return null;
        }
    },
    async setIfAbsent(key, response, ttlSeconds = config_1.config.idempotency.ttlSeconds) {
        const redis = (0, exports.getRedis)();
        const result = await redis.set(`idem:${key}`, JSON.stringify(response), 'EX', ttlSeconds, 'NX');
        return result === 'OK';
    },
    async delete(key) {
        await (0, exports.getRedis)().del(`idem:${key}`);
    },
};
exports.TransactionCache = {
    async get(transactionId) {
        const raw = await (0, exports.getRedis)().get(`txn:${transactionId}`);
        return raw ? JSON.parse(raw) : null;
    },
    async set(transactionId, data) {
        await (0, exports.getRedis)().setex(`txn:${transactionId}`, 300, JSON.stringify(data));
    },
    async invalidate(transactionId) {
        await (0, exports.getRedis)().del(`txn:${transactionId}`);
    },
};
exports.OTPStore = {
    async store(transactionId, otpHash) {
        await (0, exports.getRedis)().setex(`otp:${transactionId}`, 300, otpHash);
    },
    async get(transactionId) {
        return (0, exports.getRedis)().get(`otp:${transactionId}`);
    },
    async consume(transactionId) {
        const redis = (0, exports.getRedis)();
        const key = `otp:${transactionId}`;
        const value = await redis.get(key);
        if (value)
            await redis.del(key);
        return value;
    },
};
exports.DistributedLock = {
    async acquire(key, ttlMs = 10000) {
        const result = await (0, exports.getRedis)().set(`lock:${key}`, '1', 'PX', ttlMs, 'NX');
        return result === 'OK';
    },
    async release(key) {
        await (0, exports.getRedis)().del(`lock:${key}`);
    },
};
const closeRedis = async () => {
    if (redisClient) {
        await redisClient.quit();
        redisClient = null;
        logger_1.logger.info('Redis connection closed');
    }
};
exports.closeRedis = closeRedis;
//# sourceMappingURL=RedisClient.js.map