import type { ErrorRequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../Utils/AppError.js';

export function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message }, requestId: res.locals.requestId });
}

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (res.headersSent) return _next(error);
  const requestId = res.locals.requestId;
  if (error instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        issues: error.issues.map((i) => ({ path: i.path, message: i.message })),
      },
      requestId,
    });
    return;
  }
  if (error instanceof AppError) {
    sendError(res, error.status, error.code, error.message);
    return;
  }
  const type = (error as { type?: string })?.type;
  if (type === 'entity.too.large') {
    sendError(res, 413, 'BODY_TOO_LARGE', 'JSON body exceeds 64 KB');
    return;
  }
  if (type === 'entity.parse.failed') {
    sendError(res, 400, 'INVALID_JSON', 'Malformed JSON body');
    return;
  }
  if (type === 'encoding.unsupported') {
    sendError(res, 415, 'UNSUPPORTED_ENCODING', 'Unsupported Content-Encoding');
    return;
  }
  if (type === 'charset.unsupported') {
    sendError(res, 415, 'UNSUPPORTED_CHARSET', 'Unsupported JSON charset');
    return;
  }
  // Never log credentials, request bodies, cookies, or signed URLs.
  console.error(
    JSON.stringify({
      requestId,
      event: 'request_failed',
      method: req.method,
      path: req.path,
      errorName: error?.name ?? 'Error',
    }),
  );
  sendError(res, 500, 'INTERNAL_ERROR', 'An unexpected error occurred');
};
