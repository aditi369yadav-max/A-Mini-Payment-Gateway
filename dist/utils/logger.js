"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logError = exports.logPayment = exports.logger = void 0;
const winston_1 = __importDefault(require("winston"));
const config_1 = require("../config");
const { combine, timestamp, errors, json, colorize, simple } = winston_1.default.format;
const devFormat = combine(colorize(), timestamp({ format: 'HH:mm:ss' }), errors({ stack: true }), simple());
const prodFormat = combine(timestamp(), errors({ stack: true }), json());
exports.logger = winston_1.default.createLogger({
    level: config_1.config.app.env === 'production' ? 'info' : 'debug',
    format: config_1.config.app.env === 'production' ? prodFormat : devFormat,
    defaultMeta: { service: 'upi-gateway' },
    transports: [
        new winston_1.default.transports.Console(),
        new winston_1.default.transports.File({ filename: 'logs/error.log', level: 'error' }),
        new winston_1.default.transports.File({ filename: 'logs/combined.log' }),
    ],
});
// Structured logging helpers — use these everywhere, not console.log
const logPayment = (event, txnId, meta) => {
    exports.logger.info(event, { transactionId: txnId, ...meta });
};
exports.logPayment = logPayment;
const logError = (event, error, meta) => {
    exports.logger.error(event, {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        ...meta,
    });
};
exports.logError = logError;
//# sourceMappingURL=logger.js.map