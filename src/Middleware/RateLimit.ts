import type { RequestHandler } from 'express';
import type { Dependencies } from '../Main/Dependencies.js';
import type { RateLimitBinding } from '../Types/Environment.js';
import { digest } from '../Security/TokenService.js';
import { errorHandler } from './ErrorHandler.js';
import { errorResponse } from './ErrorResponse.js';

const keyCache = new Map<string, string>();
function rateLimitKey(scope: 'api' | 'auth', ip: string): string {
  const raw = scope + ':' + ip;
  let hashed = keyCache.get(raw);
  if (hashed === undefined) {
    if (keyCache.size >= 256) keyCache.clear();
    hashed = digest(raw);
    keyCache.set(raw, hashed);
  }
  return hashed;
}

export class LocalRateLimiter implements RateLimitBinding {
  private buckets = new Map<string, { n: number; end: number }>();
  constructor(
    private maximum: number,
    private period = 60000,
  ) {}
  async limit({ key }: { key: string }) {
    const now = Date.now();
    if (this.buckets.size > 10000) {
      for (const [k, b] of this.buckets) if (b.end <= now) this.buckets.delete(k);
      if (this.buckets.size > 10000) return { success: false };
    }
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.end <= now) {
      bucket = { n: 0, end: now + this.period };
      this.buckets.set(key, bucket);
    }
    bucket.n++;
    return { success: bucket.n <= this.maximum };
  }
}
export function rateLimit(d: Dependencies, scope: 'api' | 'auth'): RequestHandler {
  if (d.config.APP_ENV !== 'development' && !d.limiters)
    throw new Error('Production requires distributed rate limiter bindings');
  const limiter = d.limiters?.[scope] ?? new LocalRateLimiter(scope === 'auth' ? 10 : 120);
  const isWorker = d.runtime === 'worker';
  return async (req, res, next) => {
    try {
      // CF-Connecting-IP is trusted only inside the Workers adapter, never in local Node.
      const ip = isWorker
        ? ((req.headers['cf-connecting-ip'] as string | undefined) ?? 'unknown')
        : (req.ip ?? 'unknown');
      if (!(await limiter.limit({ key: rateLimitKey(scope, ip) })).success) {
        res.setHeader('Retry-After', '60');
        errorResponse(res, 429, 'RATE_LIMITED', 'Too many requests; try again shortly');
        return;
      }
      next();
    } catch (error) {
      errorHandler(error, req, res, next);
    }
  };
}
