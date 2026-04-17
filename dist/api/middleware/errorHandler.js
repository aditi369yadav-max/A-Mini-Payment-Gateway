"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestLogger = exports.errorHandler = void 0;
const DomainErrors_1 = require("../../domain/errors/DomainErrors");
const logger_1 = require("../../utils/logger");
// ============================================================
// Global Error Handler
//
// All errors bubble up here. We map domain errors to HTTP
// responses. Unknown errors become 500s.
//
// Senior engineer rule: NEVER let stack traces reach clients.
// Log everything internally, return clean messages externally.
// ============================================================
const errorHandler = (error, req, res, _next) => {
    const requestId = req.headers['x-request-id'] ?? 'unknown';
    if (error instanceof DomainErrors_1.DomainError) {
        logger_1.logger.warn('Domain error', {
            code: error.code,
            message: error.message,
            requestId,
            path: req.path,
        });
        res.status(error.httpStatus).json({
            error: error.message,
            code: error.code,
            details: error.details,
        });
        return;
    }
    // Unexpected error — log full stack, return generic message
    logger_1.logger.error('Unhandled error', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        requestId,
        path: req.path,
        method: req.method,
    });
    res.status(500).json({
        error: 'Internal server error',
        code: 'INTERNAL_ERROR',
    });
};
exports.errorHandler = errorHandler;
// Request logger middleware
const requestLogger = (req, _res, next) => {
    logger_1.logger.debug(`${req.method} ${req.path}`, {
        query: req.query,
        body: req.method !== 'GET' ? req.body : undefined,
    });
    next();
};
exports.requestLogger = requestLogger;
//# sourceMappingURL=errorHandler.js.map