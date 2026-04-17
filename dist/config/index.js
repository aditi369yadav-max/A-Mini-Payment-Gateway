"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
dotenv_1.default.config({ path: path_1.default.join(process.cwd(), '.env') });
const required = (key) => {
    const val = process.env[key];
    if (!val)
        throw new Error(`Missing required env var: ${key}`);
    return val;
};
const optional = (key, fallback) => process.env[key] ?? fallback;
exports.config = {
    app: {
        port: parseInt(optional('PORT', '3000')),
        env: optional('NODE_ENV', 'development'),
    },
    db: {
        host: optional('DB_HOST', 'localhost'),
        port: 5433,
        database: optional('DB_NAME', 'upi_gateway'),
        user: optional('DB_USER', 'postgres'),
        password: optional('DB_PASSWORD', 'postgres'),
        pool: {
            min: parseInt(optional('DB_POOL_MIN', '2')),
            max: parseInt(optional('DB_POOL_MAX', '10')),
        },
    },
    redis: {
        host: optional('REDIS_HOST', 'localhost'),
        port: parseInt(optional('REDIS_PORT', '6379')),
        password: optional('REDIS_PASSWORD', ''),
        db: parseInt(optional('REDIS_DB', '0')),
    },
    idempotency: {
        ttlSeconds: parseInt(optional('IDEMPOTENCY_TTL_SECONDS', '86400')),
    },
    retry: {
        maxAttempts: parseInt(optional('MAX_RETRY_ATTEMPTS', '3')),
        baseDelayMs: parseInt(optional('RETRY_BASE_DELAY_MS', '1000')),
        maxDelayMs: parseInt(optional('RETRY_MAX_DELAY_MS', '30000')),
    },
    webhook: {
        timeoutMs: parseInt(optional('WEBHOOK_TIMEOUT_MS', '5000')),
        maxRetries: parseInt(optional('WEBHOOK_MAX_RETRIES', '5')),
        signingSecret: optional('WEBHOOK_SIGNING_SECRET', 'dev-secret'),
    },
    payment: {
        processingDelayMs: parseInt(optional('PAYMENT_PROCESSING_DELAY_MS', '500')),
        successRate: parseFloat(optional('PAYMENT_SUCCESS_RATE', '0.85')),
    },
};
//# sourceMappingURL=index.js.map