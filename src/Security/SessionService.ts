import type { Request, Response } from 'express';
import type { Configuration } from '../Main/Configuration.js';
import { SessionRepository } from './SessionRepository.js';
import { digest, newToken } from './TokenService.js';

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export class SessionService {
  readonly cookieName: string;
  private readonly cookiePrefix: string;
  private readonly maxAgeSec: number;
  private readonly maxAgeMs: number;
  private readonly securityAttrs: string;
  private readonly clearCookieHeader: string;
  constructor(
    private repo: SessionRepository,
    private config: Configuration,
  ) {
    const isDev = config.APP_ENV === 'development';
    this.cookieName = isDev ? 'karaoke_session' : '__Host-karaoke_session';
    this.cookiePrefix = this.cookieName + '=';
    this.maxAgeSec = config.SESSION_HOURS * 3600;
    this.maxAgeMs = this.maxAgeSec * 1000;
    this.securityAttrs = isDev ? '; SameSite=Lax' : '; Secure; SameSite=None';
    this.clearCookieHeader = `${this.cookieName}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly${this.securityAttrs}`;
  }
  token(req: Request): string | undefined {
    const header = req.headers.cookie;
    if (!header) return undefined;
    const prefix = this.cookiePrefix;
    const plen = prefix.length;
    let start = 0;
    const len = header.length;
    while (start < len) {
      let segEnd = header.indexOf(';', start);
      if (segEnd === -1) segEnd = len;
      let s = start;
      let e = segEnd;
      while (s < e && header.charCodeAt(s) <= 32) s++;
      while (e > s && header.charCodeAt(e - 1) <= 32) e--;
      if (header.startsWith(prefix, s)) {
        if (e - s !== plen + 43) return undefined;
        const candidate = header.slice(s + plen, e);
        return TOKEN_RE.test(candidate) ? candidate : undefined;
      }
      start = segEnd + 1;
    }
    return undefined;
  }
  async create(userId: string, res: Response) {
    const token = newToken();
    const expiresAt = Date.now() + this.maxAgeMs;
    await this.repo.create(crypto.randomUUID(), userId, digest(token), expiresAt);
    res.append(
      'Set-Cookie',
      `${this.cookieName}=${token}; Max-Age=${this.maxAgeSec}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly${this.securityAttrs}`,
    );
  }
  authenticateToken(token: string) {
    return this.repo.findUser(digest(token));
  }
  async authenticate(req: Request) {
    const token = this.token(req);
    return token ? this.repo.findUser(digest(token)) : undefined;
  }
  async logout(req: Request, res: Response) {
    const token = this.token(req);
    if (token) await this.repo.remove(digest(token));
    res.append('Set-Cookie', this.clearCookieHeader);
  }
}
