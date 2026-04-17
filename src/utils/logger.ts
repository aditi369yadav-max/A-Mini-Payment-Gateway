import winston from 'winston';
import { config } from '../config';

const { combine, timestamp, errors, json, colorize, simple } = winston.format;

const devFormat = combine(
  colorize(),
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),
  simple()
);

const prodFormat = combine(
  timestamp(),
  errors({ stack: true }),
  json()
);

export const logger = winston.createLogger({
  level: config.app.env === 'production' ? 'info' : 'debug',
  format: config.app.env === 'production' ? prodFormat : devFormat,
  defaultMeta: { service: 'upi-gateway' },
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});

// Structured logging helpers — use these everywhere, not console.log
export const logPayment = (
  event: string,
  txnId: string,
  meta?: Record<string, unknown>
) => {
  logger.info(event, { transactionId: txnId, ...meta });
};

export const logError = (
  event: string,
  error: unknown,
  meta?: Record<string, unknown>
) => {
  logger.error(event, {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    ...meta,
  });
};
