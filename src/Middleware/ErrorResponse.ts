import type { Response } from 'express';

/** Expected denials are ordinary responses; unexpected failures still use errorHandler. */
export function errorResponse(res: Response, status: number, code: string, message: string) {
  res.status(status).json({ error: { code, message }, requestId: res.locals.requestId });
}
