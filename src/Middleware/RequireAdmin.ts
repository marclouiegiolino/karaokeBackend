import type { RequestHandler } from 'express';
import { errorResponse } from './ErrorResponse.js';
export const requireAdmin: RequestHandler = (_req, res, next) => {
  if (res.locals.user?.role !== 'ADMIN') {
    errorResponse(res, 403, 'FORBIDDEN', 'Administrator access is required');
    return;
  }
  next();
};
