import * as zlib from 'node:zlib';
import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import type { Dependencies } from './Main/Dependencies.js';
import { rateLimit } from './Middleware/RateLimit.js';
import { errorHandler, sendError } from './Middleware/ErrorHandler.js';
import { routes } from './Routes/index.js';
import { AppError } from './Utils/AppError.js';

export const SECURITY_HEADERS: readonly [string, string][] = [
  ['Cache-Control', 'no-store'],
  [
    'Content-Security-Policy',
    "default-src 'self';base-uri 'self';font-src 'self' https: data:;form-action 'self';frame-ancestors 'self';img-src 'self' data:;object-src 'none';script-src 'self';script-src-attr 'none';style-src 'self' https: 'unsafe-inline';upgrade-insecure-requests",
  ],
  ['Cross-Origin-Opener-Policy', 'same-origin'],
  ['Cross-Origin-Resource-Policy', 'same-origin'],
  ['Origin-Agent-Cluster', '?1'],
  ['Referrer-Policy', 'no-referrer'],
  ['Strict-Transport-Security', 'max-age=31536000; includeSubDomains'],
  ['X-Content-Type-Options', 'nosniff'],
  ['X-DNS-Prefetch-Control', 'off'],
  ['X-Download-Options', 'noopen'],
  ['X-Frame-Options', 'SAMEORIGIN'],
  ['X-Permitted-Cross-Domain-Policies', 'none'],
  ['X-XSS-Protection', '0'],
];

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_JSON_BYTES = 65536;
const MAX_COMPRESSED_WIRE_BYTES = 262144;
const JSON_MIME_RE = /^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)$/i;
const CHARSET_PARAM_RE = /;\s*charset\s*=\s*(?:"([^"]*)"|([^\s;]*))/i;
const HAS_ZSTD = 'createZstdDecompress' in zlib;

class JsonBodyLimitError extends Error {}

type DecompressStream = zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | zlib.ZstdDecompress;

function createDecompressor(encoding: string): DecompressStream | undefined {
  switch (encoding) {
    case 'gzip':
      return zlib.createGunzip({ chunkSize: 16384 });
    case 'deflate':
      return zlib.createInflate({ chunkSize: 16384 });
    case 'br':
      return zlib.createBrotliDecompress({ chunkSize: 16384 });
    case 'zstd':
      return HAS_ZSTD ? zlib.createZstdDecompress() : undefined;
    default:
      return undefined;
  }
}

function cancelOrDrain(req: Request, rawReq?: globalThis.Request): Promise<void> {
  if (rawReq?.body) return rawReq.body.cancel().catch(() => {});
  req.resume();
  return Promise.resolve();
}

function mergeChunks(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return merged;
}

function isStrictJsonStart(text: string): boolean {
  const len = text.length;
  for (let i = 0; i < len; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) continue;
    return c === 123 || c === 91; // '{' or '['
  }
  return false;
}

function parseJsonContentType(header: string | undefined): {
  isJson: boolean;
  validCharset: boolean;
} {
  if (!header) return { isJson: false, validCharset: true };
  const semi = header.indexOf(';');
  const mime = (semi === -1 ? header : header.slice(0, semi)).trim();
  if (!JSON_MIME_RE.test(mime)) return { isJson: false, validCharset: true };
  if (semi === -1) return { isJson: true, validCharset: true };
  const match = CHARSET_PARAM_RE.exec(header.slice(semi));
  if (!match) return { isJson: true, validCharset: true };
  const charset = (match[1] ?? match[2] ?? '').toLowerCase();
  return { isJson: true, validCharset: charset === 'utf-8' || charset === 'utf8' };
}

async function readIdentityJsonBytes(
  req: Request,
  rawReq: globalThis.Request | undefined,
  expectedLength: number | undefined,
): Promise<Uint8Array | null> {
  if (rawReq) {
    if (!rawReq.body) {
      if (expectedLength !== undefined && expectedLength > 0) {
        throw new AppError(400, 'INVALID_BODY_LENGTH', 'Request size did not match Content-Length');
      }
      return null;
    }
    const reader = rawReq.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          total += value.byteLength;
          if (total > MAX_JSON_BYTES) {
            await reader.cancel().catch(() => {});
            throw new JsonBodyLimitError();
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
    if (expectedLength !== undefined && total !== expectedLength) {
      throw new AppError(400, 'INVALID_BODY_LENGTH', 'Request size did not match Content-Length');
    }
    return total === 0 ? null : mergeChunks(chunks, total);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  let tooLarge = false;
  await new Promise<void>((resolve, reject) => {
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      total += chunk.length;
      if (total > MAX_JSON_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve());
    req.on('error', reject);
  });
  if (tooLarge) {
    req.resume();
    throw new JsonBodyLimitError();
  }
  if (expectedLength !== undefined && total !== expectedLength) {
    throw new AppError(400, 'INVALID_BODY_LENGTH', 'Request size did not match Content-Length');
  }
  return total === 0 ? null : mergeChunks(chunks, total);
}

function readCompressedJsonBytes(
  dec: DecompressStream,
  expectedLength: number | undefined,
  req: Request,
  rawReq?: globalThis.Request,
): Promise<Uint8Array | null> {
  return new Promise<Uint8Array | null>((resolve, reject) => {
    const outChunks: Buffer[] = [];
    let wireTotal = 0;
    let outTotal = 0;
    let finished = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    const stopSource = async () => {
      if (rawReq?.body) {
        if (reader) {
          await reader.cancel().catch(() => {});
        } else {
          await rawReq.body.cancel().catch(() => {});
        }
      } else {
        req.off('data', onNodeData);
        req.off('end', onNodeEnd);
        req.off('error', onNodeErr);
        req.resume();
      }
    };

    const abortWith = (err: unknown) => {
      if (finished) return;
      finished = true;
      dec.destroy();
      void stopSource().finally(() => {
        reader?.releaseLock();
        reject(err);
      });
    };

    dec.on('drain', () => {
      if (!finished && !rawReq) req.resume();
    });

    dec.on('data', (chunk: Buffer) => {
      if (finished || chunk.byteLength === 0) return;
      outTotal += chunk.byteLength;
      if (outTotal > MAX_JSON_BYTES) {
        abortWith(new JsonBodyLimitError());
        return;
      }
      outChunks.push(chunk);
    });

    dec.on('end', () => {
      if (finished) return;
      finished = true;
      reader?.releaseLock();
      if (expectedLength !== undefined && wireTotal !== expectedLength) {
        reject(
          new AppError(400, 'INVALID_BODY_LENGTH', 'Request size did not match Content-Length'),
        );
        return;
      }
      resolve(outTotal === 0 ? null : mergeChunks(outChunks, outTotal));
    });

    dec.on('error', (err) => {
      abortWith(err);
    });

    const pushWireChunk = (chunk: Uint8Array): boolean => {
      if (finished || chunk.byteLength === 0) return true;
      wireTotal += chunk.byteLength;
      if (wireTotal > MAX_COMPRESSED_WIRE_BYTES) {
        abortWith(new JsonBodyLimitError());
        return false;
      }
      return dec.write(chunk);
    };

    function onNodeData(chunk: Buffer) {
      if (!pushWireChunk(chunk) && !finished) {
        req.pause();
      }
    }
    function onNodeEnd() {
      if (!finished) dec.end();
    }
    function onNodeErr(err: unknown) {
      abortWith(err);
    }

    if (rawReq) {
      if (!rawReq.body) {
        dec.end();
        return;
      }
      reader = rawReq.body.getReader();
      (async () => {
        try {
          for (;;) {
            if (finished) break;
            const { done, value } = await reader.read();
            if (done || finished) break;
            if (value && !pushWireChunk(value) && !finished) {
              await new Promise<void>((r) => {
                if (finished || dec.destroyed) {
                  r();
                  return;
                }
                const doneWait = () => {
                  dec.off('drain', doneWait);
                  dec.off('close', doneWait);
                  dec.off('error', doneWait);
                  r();
                };
                dec.once('drain', doneWait);
                dec.once('close', doneWait);
                dec.once('error', doneWait);
              });
            }
          }
          if (!finished) dec.end();
        } catch (err) {
          abortWith(err);
        }
      })();
    } else {
      req.on('data', onNodeData);
      req.on('end', onNodeEnd);
      req.on('error', onNodeErr);
    }
  });
}

async function parseJsonBodyAsync(
  req: Request,
  res: Response,
  next: NextFunction,
  rawReq: globalThis.Request | undefined,
  contentLengthHeader: string | undefined,
  validCharset: boolean,
) {
  if (!validCharset) {
    await cancelOrDrain(req, rawReq);
    sendError(res, 415, 'UNSUPPORTED_CHARSET', 'Unsupported JSON charset');
    return;
  }

  const contentEncoding = (req.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
  const decompressor =
    contentEncoding === 'identity' ? undefined : createDecompressor(contentEncoding);
  if (contentEncoding !== 'identity' && !decompressor) {
    await cancelOrDrain(req, rawReq);
    sendError(res, 415, 'UNSUPPORTED_ENCODING', 'Unsupported Content-Encoding');
    return;
  }

  let expectedLength: number | undefined;
  if (contentLengthHeader !== undefined) {
    const trimmedLength = contentLengthHeader.trim();
    if (!/^\d+$/.test(trimmedLength)) {
      await cancelOrDrain(req, rawReq);
      sendError(res, 400, 'INVALID_CONTENT_LENGTH', 'Invalid Content-Length header');
      return;
    }
    expectedLength = Number(trimmedLength);
    if (!Number.isSafeInteger(expectedLength)) {
      await cancelOrDrain(req, rawReq);
      sendError(res, 400, 'INVALID_CONTENT_LENGTH', 'Invalid Content-Length header');
      return;
    }
    if (contentEncoding === 'identity' && expectedLength > MAX_JSON_BYTES) {
      await cancelOrDrain(req, rawReq);
      sendError(res, 413, 'BODY_TOO_LARGE', 'JSON body exceeds 64 KB');
      return;
    }
  }

  try {
    const bytes = decompressor
      ? await readCompressedJsonBytes(decompressor, expectedLength, req, rawReq)
      : await readIdentityJsonBytes(req, rawReq, expectedLength);
    if (!bytes) {
      req.body = {};
      next();
      return;
    }
    const text = utf8Decoder.decode(bytes);
    if (!isStrictJsonStart(text)) {
      sendError(res, 400, 'INVALID_JSON', 'Malformed JSON body');
      return;
    }
    req.body = JSON.parse(text);
    next();
  } catch (err) {
    if (err instanceof JsonBodyLimitError) {
      sendError(res, 413, 'BODY_TOO_LARGE', 'JSON body exceeds 64 KB');
    } else if (err instanceof AppError) {
      sendError(res, err.status, err.code, err.message);
    } else {
      sendError(res, 400, 'INVALID_JSON', 'Malformed JSON body');
    }
  }
}

const parseJsonBody: RequestHandler = (req, res, next) => {
  if (req.body !== undefined) {
    next();
    return;
  }
  const contentLengthHeader = req.headers['content-length'];
  const transferEncoding = req.headers['transfer-encoding'];
  const rawReq = (req as Request & { _rawRequest?: globalThis.Request })._rawRequest;
  const hasBody =
    transferEncoding !== undefined || contentLengthHeader !== undefined || Boolean(rawReq?.body);
  if (!hasBody) {
    next();
    return;
  }

  const { isJson, validCharset } = parseJsonContentType(req.headers['content-type']);
  if (!isJson) {
    next();
    return;
  }
  return parseJsonBodyAsync(req, res, next, rawReq, contentLengthHeader, validCharset);
};

export function createApp(d: Dependencies) {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.set('trust proxy', false);
  const allowedOrigins = new Set(d.config.origins);
  const singleOrigin = d.config.origins.length === 1 ? d.config.origins[0]! : undefined;

  app.use((req, res, next) => {
    const requestId = crypto.randomUUID();
    res.locals.requestId = requestId;
    if (!(res as unknown as { _preseededHeaders?: boolean })._preseededHeaders) {
      for (let i = 0; i < SECURITY_HEADERS.length; i++) {
        const [k, v] = SECURITY_HEADERS[i]!;
        res.setHeader(k, v);
      }
    }
    res.setHeader('X-Request-Id', requestId);

    const origin = req.headers.origin;
    if (origin && (singleOrigin ? origin !== singleOrigin : !allowedOrigins.has(origin))) {
      sendError(res, 403, 'ORIGIN_DENIED', 'Origin is not allowed');
      return;
    }
    const method = req.method;
    // Same-origin checks protect cookie-authenticated JSON mutations, including login CSRF.
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && !origin) {
      sendError(res, 403, 'ORIGIN_REQUIRED', 'An allowed Origin header is required');
      return;
    }

    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id');

    if (method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
      res.setHeader('Content-Length', '0');
      res.statusCode = 204;
      res.end();
      return;
    }
    next();
  });

  app.use('/api', rateLimit(d, 'api'), parseJsonBody, routes(d));
  app.use((_req, res) => {
    sendError(res, 404, 'NOT_FOUND', 'API route not found');
  });
  app.use(errorHandler);
  return app;
}
