import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(process.cwd(), '.env') });

import express from 'express';
import { config } from './config';
import { logger } from './utils/logger';
import { paymentRoutes } from './api/routes/payment.routes';
import { webhookRoutes } from './api/routes/webhook.routes';
import { errorHandler, requestLogger } from './api/middleware/errorHandler';
import { getPool } from './infrastructure/db/postgres';
import { getRedis } from './infrastructure/cache/RedisClient';
import { processWebhookRetries } from './infrastructure/webhook/WebhookSender';

// Debug — remove after confirming it works
console.log('DB CONFIG:', { host: config.db.host, port: config.db.port, database: config.db.database });

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(requestLogger);

app.use((req, _res, next) => {
  req.headers['x-request-id'] =
    req.headers['x-request-id'] ?? `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  next();
});

app.get('/health', async (_req, res) => {
  try {
    await getPool().query('SELECT 1');
    await getRedis().ping();
    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      services: { database: 'connected', redis: 'connected' },
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.use('/api/payments', paymentRoutes);
app.use('/api/webhooks', webhookRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found', code: 'NOT_FOUND' });
});

app.use(errorHandler);

const startBackgroundJobs = (): void => {
  setInterval(() => {
    processWebhookRetries().catch((err) =>
      logger.error('Webhook retry worker failed', { error: err.message })
    );
  }, 30_000);
  logger.info('Background jobs started');
};

const start = async (): Promise<void> => {
  try {
    console.log('Attempting DB connection on port:', config.db.port);
    await getPool().query('SELECT NOW()');
    logger.info('PostgreSQL connection verified');

    await getRedis().ping();
    logger.info('Redis connection verified');

    startBackgroundJobs();

    app.listen(config.app.port, () => {
      logger.info(`UPI Gateway running on port ${config.app.port}`);
    });
  } catch (error) {
    logger.error('Failed to start server', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
};

const shutdown = async (signal: string): Promise<void> => {
  logger.info(`${signal} received. Shutting down gracefully...`);
  const { closePool } = await import('./infrastructure/db/postgres');
  const { closeRedis } = await import('./infrastructure/cache/RedisClient');
  await Promise.allSettled([closePool(), closeRedis()]);
  logger.info('Shutdown complete');
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason });
});

start();

export { app };