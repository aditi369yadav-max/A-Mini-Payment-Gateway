"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.app = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
dotenv_1.default.config({ path: path_1.default.join(process.cwd(), '.env') });
const express_1 = __importDefault(require("express"));
const config_1 = require("./config");
const logger_1 = require("./utils/logger");
const payment_routes_1 = require("./api/routes/payment.routes");
const webhook_routes_1 = require("./api/routes/webhook.routes");
const errorHandler_1 = require("./api/middleware/errorHandler");
const postgres_1 = require("./infrastructure/db/postgres");
const RedisClient_1 = require("./infrastructure/cache/RedisClient");
const WebhookSender_1 = require("./infrastructure/webhook/WebhookSender");
// Debug — remove after confirming it works
console.log('DB CONFIG:', { host: config_1.config.db.host, port: config_1.config.db.port, database: config_1.config.db.database });
const app = (0, express_1.default)();
exports.app = app;
app.use(express_1.default.json({ limit: '1mb' }));
app.use(express_1.default.urlencoded({ extended: true }));
app.use(errorHandler_1.requestLogger);
app.use((req, _res, next) => {
    req.headers['x-request-id'] =
        req.headers['x-request-id'] ?? `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    next();
});
app.get('/health', async (_req, res) => {
    try {
        await (0, postgres_1.getPool)().query('SELECT 1');
        await (0, RedisClient_1.getRedis)().ping();
        res.status(200).json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            services: { database: 'connected', redis: 'connected' },
        });
    }
    catch (error) {
        res.status(503).json({
            status: 'unhealthy',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
});
app.use('/api/payments', payment_routes_1.paymentRoutes);
app.use('/api/webhooks', webhook_routes_1.webhookRoutes);
app.use((_req, res) => {
    res.status(404).json({ error: 'Route not found', code: 'NOT_FOUND' });
});
app.use(errorHandler_1.errorHandler);
const startBackgroundJobs = () => {
    setInterval(() => {
        (0, WebhookSender_1.processWebhookRetries)().catch((err) => logger_1.logger.error('Webhook retry worker failed', { error: err.message }));
    }, 30000);
    logger_1.logger.info('Background jobs started');
};
const start = async () => {
    try {
        console.log('Attempting DB connection on port:', config_1.config.db.port);
        await (0, postgres_1.getPool)().query('SELECT NOW()');
        logger_1.logger.info('PostgreSQL connection verified');
        await (0, RedisClient_1.getRedis)().connect();
        await (0, RedisClient_1.getRedis)().ping();
        logger_1.logger.info('Redis connection verified');
        startBackgroundJobs();
        app.listen(config_1.config.app.port, () => {
            logger_1.logger.info(`UPI Gateway running on port ${config_1.config.app.port}`);
        });
    }
    catch (error) {
        logger_1.logger.error('Failed to start server', {
            error: error instanceof Error ? error.message : String(error),
        });
        process.exit(1);
    }
};
const shutdown = async (signal) => {
    logger_1.logger.info(`${signal} received. Shutting down gracefully...`);
    const { closePool } = await Promise.resolve().then(() => __importStar(require('./infrastructure/db/postgres')));
    const { closeRedis } = await Promise.resolve().then(() => __importStar(require('./infrastructure/cache/RedisClient')));
    await Promise.allSettled([closePool(), closeRedis()]);
    logger_1.logger.info('Shutdown complete');
    process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
    logger_1.logger.error('Unhandled promise rejection', { reason });
});
start();
//# sourceMappingURL=app.js.map