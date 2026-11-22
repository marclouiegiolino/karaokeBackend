import { env } from 'cloudflare:workers';
import { TursoHttpDatabase } from './Main/TursoHttpDatabase.js';
import { loadConfiguration } from './Main/Configuration.js';
import { buildDependencies } from './Main/Dependencies.js';
import { R2FileStorage } from './Modules/Services/R2FileStorage.js';
import { createApp, SECURITY_HEADERS } from './app.js';
import { errorHandler } from './Middleware/ErrorHandler.js';
import type { Environment } from './Types/Environment.js';

const bindings = env as unknown as Environment;
const config = loadConfiguration(bindings);
if (config.TURSO_DATABASE_URL.startsWith('file:'))
  throw new Error('Workers requires remote Turso. Use npm run dev for local SQLite.');
if (!bindings.API_LIMITER || !bindings.AUTH_LIMITER)
  throw new Error('Configure rate limiter bindings');
const db = new TursoHttpDatabase({
  url: config.TURSO_DATABASE_URL,
  authToken: config.TURSO_AUTH_TOKEN!,
});
const storage = new R2FileStorage(config, fetch, bindings.MEDIA_BUCKET);
await db.prewarm();
await storage.prewarm();
const app = createApp(
  buildDependencies(
    config,
    db,
    storage,
    { api: bindings.API_LIMITER, auth: bindings.AUTH_LIMITER },
    'worker',
  ),
);

const utf8Encoder = new TextEncoder();
const baseHeaders = new Headers(SECURITY_HEADERS as [string, string][]);
const workerSocket = Object.freeze({
  encrypted: true,
  remoteAddress: '127.0.0.1',
});
Object.defineProperty(app.request, 'socket', {
  value: workerSocket,
  configurable: true,
  writable: true,
});
Object.defineProperty(app.response, 'headersSent', {
  value: false,
  configurable: true,
  writable: true,
});

function dispatchToExpress(request: Request): Promise<Response> {
  return new Promise<Response>((resolve) => {
    const rawUrl = request.url;
    const schemeEnd = rawUrl.indexOf('://');
    const pathStart = schemeEnd === -1 ? 0 : rawUrl.indexOf('/', schemeEnd + 3);
    const url = pathStart === -1 ? '/' : rawUrl.slice(pathStart);

    const headers: Record<string, string> = Object.create(null);
    request.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    const req = Object.create(app.request);
    req.method = request.method;
    req.url = url;
    req.originalUrl = url;
    req.headers = headers;
    req._rawRequest = request;

    const resHeaders = new Headers(baseHeaders);
    const res = Object.create(app.response);
    res._preseededHeaders = true;
    res.statusCode = 200;
    res.headersSent = false;
    res.locals = Object.create(null);
    req.res = res;
    res.req = req;

    res.setHeader = function (name: string, value: string | number | readonly string[]) {
      if (Array.isArray(value)) {
        resHeaders.delete(name);
        for (let i = 0; i < value.length; i++) resHeaders.append(name, String(value[i]));
      } else {
        resHeaders.set(name, String(value));
      }
      return res;
    };
    res.getHeader = function (name: string) {
      return resHeaders.get(name) ?? undefined;
    };
    res.removeHeader = function (name: string) {
      resHeaders.delete(name);
    };
    res.set = res.header = function (field: string, val: string | string[]) {
      return res.setHeader(field, val);
    };
    res.get = function (field: string) {
      return resHeaders.get(field) ?? undefined;
    };
    res.append = function (field: string, val: string | string[]) {
      if (Array.isArray(val)) {
        for (let i = 0; i < val.length; i++) resHeaders.append(field, String(val[i]));
      } else {
        resHeaders.append(field, String(val));
      }
      return res;
    };
    res.status = function (code: number) {
      res.statusCode = code;
      return res;
    };
    res.json = function (obj: unknown) {
      const bytes = utf8Encoder.encode(JSON.stringify(obj));
      if (!resHeaders.has('content-type')) {
        resHeaders.set('content-type', 'application/json; charset=utf-8');
      }
      if (res.statusCode !== 204 && res.statusCode !== 304) {
        resHeaders.set('content-length', String(bytes.byteLength));
      }
      return res.end(bytes);
    };
    res.end = function (chunk?: unknown) {
      if (res.headersSent) return res;
      res.headersSent = true;
      const status = res.statusCode;
      if (status === 204 || status === 304) {
        resHeaders.delete('content-type');
        resHeaders.delete('content-length');
        resHeaders.delete('transfer-encoding');
      }
      const body =
        status === 204 || status === 304 || req.method === 'HEAD' || chunk === undefined
          ? null
          : typeof chunk === 'string' || chunk instanceof Uint8Array || chunk instanceof ArrayBuffer
            ? (chunk as BodyInit)
            : String(chunk);
      resolve(new Response(body, { status, headers: resHeaders }));
      return res;
    };

    (app as unknown as (req: unknown, res: unknown, next: (err?: unknown) => void) => void)(
      req,
      res,
      (err?: unknown) => {
        if (err) {
          errorHandler(err, req, res, () => {});
        } else if (!res.headersSent) {
          res.status(404).end();
        }
      },
    );
  });
}

export default {
  fetch(request: Request) {
    return dispatchToExpress(request);
  },
  async scheduled() {
    const now = Date.now();
    // No schema creation on requests or scheduled jobs; migrations run separately.
    await db.batch(
      [
        {
          sql: "UPDATE storage_budget SET reserved_bytes=reserved_bytes-(SELECT COALESCE(SUM(byte_size),0) FROM uploads WHERE status='PENDING' AND expires_at<?) WHERE id=1",
          args: [now],
        },
        {
          sql: "UPDATE uploads SET status='EXPIRED' WHERE status='PENDING' AND expires_at<?",
          args: [now],
        },
        { sql: 'DELETE FROM sessions WHERE expires_at<?', args: [now] },
      ],
      'write',
    );
  },
};
