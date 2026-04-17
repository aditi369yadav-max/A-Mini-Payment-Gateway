import Redis from 'ioredis';
import { config } from '../../config';
import { logger } from '../../utils/logger';

let redisClient: Redis | null = null;

export const getRedis = (): Redis => {
  if (!redisClient) {
    redisClient = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password || undefined,
      db: config.redis.db,
      retryStrategy: (times) => Math.min(times * 100, 3000),
      lazyConnect: true,
    });
    redisClient.on('connect', () => logger.info('Redis connected'));
    redisClient.on('error', (err) => logger.error('Redis error', { error: err.message }));
    redisClient.on('reconnecting', () => logger.warn('Redis reconnecting'));
  }
  return redisClient;
};

export const IdempotencyCache = {
  async get(key: string): Promise<{ status: number; body: unknown } | null> {
    const redis = getRedis();
    const raw = await redis.get(`idem:${key}`);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  },
  async setIfAbsent(key: string, response: { status: number; body: unknown }, ttlSeconds: number = config.idempotency.ttlSeconds): Promise<boolean> {
    const redis = getRedis();
    const result = await redis.set(`idem:${key}`, JSON.stringify(response), 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  },
  async delete(key: string): Promise<void> {
    await getRedis().del(`idem:${key}`);
  },
};

export const TransactionCache = {
  async get(transactionId: string): Promise<unknown | null> {
    const raw = await getRedis().get(`txn:${transactionId}`);
    return raw ? JSON.parse(raw) : null;
  },
  async set(transactionId: string, data: unknown): Promise<void> {
    await getRedis().setex(`txn:${transactionId}`, 300, JSON.stringify(data));
  },
  async invalidate(transactionId: string): Promise<void> {
    await getRedis().del(`txn:${transactionId}`);
  },
};

export const OTPStore = {
  async store(transactionId: string, otpHash: string): Promise<void> {
    await getRedis().setex(`otp:${transactionId}`, 300, otpHash);
  },
  async get(transactionId: string): Promise<string | null> {
    return getRedis().get(`otp:${transactionId}`);
  },
  async consume(transactionId: string): Promise<string | null> {
    const redis = getRedis();
    const key = `otp:${transactionId}`;
    const value = await redis.get(key);
    if (value) await redis.del(key);
    return value;
  },
};

export const DistributedLock = {
  async acquire(key: string, ttlMs: number = 10000): Promise<boolean> {
    const result = await getRedis().set(`lock:${key}`, '1', 'PX', ttlMs, 'NX');
    return result === 'OK';
  },
  async release(key: string): Promise<void> {
    await getRedis().del(`lock:${key}`);
  },
};

export const closeRedis = async (): Promise<void> => {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    logger.info('Redis connection closed');
  }
};