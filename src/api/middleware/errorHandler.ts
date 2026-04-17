import { Request, Response, NextFunction } from 'express';
import { DomainError } from '../../domain/errors/DomainErrors';
import { logger } from '../../utils/logger';

// ============================================================
// Global Error Handler
//
// All errors bubble up here. We map domain errors to HTTP
// responses. Unknown errors become 500s.
//
// Senior engineer rule: NEVER let stack traces reach clients.
// Log everything internally, return clean messages externally.
// ============================================================
export const errorHandler = (
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  const requestId = (req.headers['x-request-id'] as string) ?? 'unknown';

  if (error instanceof DomainError) {
    logger.warn('Domain error', {
      code:      error.code,
      message:   error.message,
      requestId,
      path:      req.path,
    });

    res.status(error.httpStatus).json({
      error:   error.message,
      code:    error.code,
      details: error.details,
    });
    return;
  }

  // Unexpected error — log full stack, return generic message
  logger.error('Unhandled error', {
    error:     error instanceof Error ? error.message : String(error),
    stack:     error instanceof Error ? error.stack  : undefined,
    requestId,
    path:      req.path,
    method:    req.method,
  });

  res.status(500).json({
    error: 'Internal server error',
    code:  'INTERNAL_ERROR',
  });
};

// Request logger middleware
export const requestLogger = (
  req: Request,
  _res: Response,
  next: NextFunction
): void => {
  logger.debug(`${req.method} ${req.path}`, {
    query:  req.query,
    body:   req.method !== 'GET' ? req.body : undefined,
  });
  next();
};
