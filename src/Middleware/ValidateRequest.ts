import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { errorHandler } from './ErrorHandler.js';

export type FastValidatedSchema<T = unknown> = ZodType<T> & {
  _fastParse?: (input: unknown) => T | undefined;
};

export function validateRequest<T>(schema: FastValidatedSchema<T>): RequestHandler {
  const fast = schema._fastParse;
  return (req, res, next) => {
    if (fast) {
      const parsed = fast(req.body);
      if (parsed !== undefined) {
        res.locals.input = parsed;
        next();
        return;
      }
    }
    try {
      res.locals.input = schema.parse(req.body);
      next();
    } catch (error) {
      errorHandler(error, req, res, next);
    }
  };
}
