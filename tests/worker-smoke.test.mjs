import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as zlib from 'node:zlib';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createClient } from '@libsql/client';
import { createHmac, pbkdf2Sync, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { unstable_readConfig } from 'wrangler';

test('bundled Express app serves health, login, session lookup, and revocation in the Workers runtime', async () => {
  const origin = 'https://karaoke.example.com';
  const pepper = 'test-only-karaoke-dedicated-pepper-32-characters';
  const password = 'fixture-only-password-12345';
  const salt = Buffer.alloc(32, 7);
  const derived = pbkdf2Sync(
    createHmac('sha256', pepper).update(password).digest(),
    salt,
    12000,
    32,
    'sha256',
  );
  const encodedHash =
    '$pbkdf2-sha256$12000$' + salt.toString('hex') + '$' + derived.toString('hex');
  const legacySalt = Buffer.alloc(16, 9);
  const legacyHash =
    'pbkdf2-sha256$600000$' +
    legacySalt.toString('hex') +
    '$' +
    pbkdf2Sync(password, legacySalt, 600000, 32, 'sha256').toString('hex');

  const db = createClient({ url: 'file::memory:' });
  await db.executeMultiple(await readFile('src/Migrations/0001_initial.sql', 'utf8'));
  const adminId = randomUUID();
  const userId = randomUUID();
  const inactiveId = randomUUID();
  const legacyId = randomUUID();
  for (const [id, name, role, active, hashValue] of [
    [adminId, 'fixtureadmin', 'ADMIN', 1, encodedHash],
    [userId, 'fixtureuser', 'USER', 1, encodedHash],
    [inactiveId, 'inactiveuser', 'USER', 0, encodedHash],
    [legacyId, 'legacyuser', 'USER', 1, legacyHash],
  ]) {
    await db.execute({
      sql: 'INSERT INTO users(id,username,email,display_name,password_hash,role,is_active,created_at) VALUES(?,?,?,?,?,?,?,?)',
      args: [id, name, `${name}@example.com`, name, hashValue, role, active, Date.now()],
    });
  }

  const r2Objects = new Map();
  const heads = new Map();
  const storedSqls = new Map();
  const fromHranaArg = (a) =>
    a.type === 'null' ? null : a.type === 'integer' ? Number(a.value) : a.value;
  const toHranaVal = (v) =>
    v === null || v === undefined
      ? { type: 'null' }
      : typeof v === 'number'
        ? Number.isInteger(v)
          ? { type: 'integer', value: String(v) }
          : { type: 'float', value: v }
        : typeof v === 'bigint'
          ? { type: 'integer', value: String(v) }
          : { type: 'text', value: String(v) };
  const formatExecResult = (rs) => ({
    cols: rs.columns.map((name) => ({ name, decltype: null })),
    rows: rs.rows.map((row) => rs.columns.map((col) => toHranaVal(row[col]))),
    affected_row_count: rs.rowsAffected,
    last_insert_rowid: rs.lastInsertRowid != null ? String(rs.lastInsertRowid) : null,
  });

  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'test-worker',
          modules: true,
          scriptPath: 'dist/index.js',
          compatibilityDate: '2026-11-17',
          compatibilityFlags: ['nodejs_compat'],
          outboundService: async (req) => {
            const u = new URL(req.url);
            if (u.hostname.endsWith('.r2.cloudflarestorage.com')) {
              const key = decodeURIComponent(u.pathname.replace(/^\/test-not-contacted\//, ''));
              if (req.method === 'HEAD') {
                heads.set(key, (heads.get(key) ?? 0) + 1);
                const obj = r2Objects.get(key);
                if (!obj) return new Response(null, { status: 404 });
                const headers = { 'content-type': obj.type, etag: obj.etag };
                if (!obj.omitHeadLength) headers['content-length'] = String(obj.bytes.byteLength);
                return new Response(null, { status: 200, headers });
              }
              if (req.method === 'GET') {
                const obj = r2Objects.get(key);
                if (!obj) return new Response(null, { status: 404 });
                assert.equal(req.headers.get('if-match'), obj.etag);
                const range = req.headers.get('range');
                if (range) {
                  const m = /^bytes=(\d+)-(\d+)$/.exec(range);
                  const start = Number(m[1]);
                  const end = Math.min(Number(m[2]), obj.bytes.byteLength - 1);
                  const slice = obj.bytes.slice(start, end + 1);
                  return new Response(slice, {
                    status: 206,
                    headers: {
                      'content-type': obj.type,
                      'content-length': String(slice.byteLength),
                      'content-range': `bytes ${start}-${end}/${obj.bytes.byteLength}`,
                      etag: obj.etag,
                    },
                  });
                }
                return new Response(obj.bytes, {
                  status: 200,
                  headers: {
                    'content-type': obj.type,
                    'content-length': String(obj.bytes.byteLength),
                    etag: obj.etag,
                  },
                });
              }
              if (req.method === 'PUT' && req.headers.has('x-amz-copy-source')) {
                const src = decodeURIComponent(
                  req.headers.get('x-amz-copy-source').replace(/^\/?test-not-contacted\//, ''),
                );
                const obj = r2Objects.get(src);
                assert.equal(req.headers.get('x-amz-copy-source-if-match'), obj.etag);
                r2Objects.set(key, {
                  bytes: obj.bytes,
                  type: req.headers.get('content-type') || obj.type,
                  etag: '"copied-etag"',
                });
                return new Response(
                  '<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><ETag>"copied-etag"</ETag></CopyObjectResult>',
                  { status: 200, headers: { 'content-type': 'application/xml' } },
                );
              }
              if (req.method === 'DELETE') {
                r2Objects.delete(key);
                return new Response(null, { status: 204 });
              }
            }
            const body = await req.json();
            const results = [];
            let closed = false;
            for (const item of body.requests) {
              if (item.type === 'store_sql') {
                storedSqls.set(item.sql_id, item.sql);
                results.push({ type: 'ok', response: { type: 'store_sql' } });
              } else if (item.type === 'close_sql') {
                storedSqls.delete(item.sql_id);
                results.push({ type: 'ok', response: { type: 'close_sql' } });
              } else if (item.type === 'execute') {
                const sql = item.stmt.sql ?? storedSqls.get(item.stmt.sql_id);
                if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) {
                  results.push({
                    type: 'ok',
                    response: {
                      type: 'execute',
                      result: {
                        cols: [],
                        rows: [],
                        affected_row_count: 0,
                        last_insert_rowid: null,
                      },
                    },
                  });
                } else {
                  const args = (item.stmt.args ?? []).map(fromHranaArg);
                  const rs = await db.execute({ sql, args });
                  results.push({
                    type: 'ok',
                    response: { type: 'execute', result: formatExecResult(rs) },
                  });
                }
              } else if (item.type === 'batch') {
                const step_results = [];
                const step_errors = [];
                for (const step of item.batch.steps) {
                  if (step.condition?.type === 'not') {
                    step_results.push(null);
                    step_errors.push(null);
                    continue;
                  }
                  const sql = step.stmt.sql ?? storedSqls.get(step.stmt.sql_id);
                  if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) {
                    step_results.push({
                      cols: [],
                      rows: [],
                      affected_row_count: 0,
                      last_insert_rowid: null,
                    });
                    step_errors.push(null);
                  } else {
                    const args = (step.stmt.args ?? []).map(fromHranaArg);
                    const rs = await db.execute({ sql, args });
                    step_results.push(formatExecResult(rs));
                    step_errors.push(null);
                  }
                }
                results.push({
                  type: 'ok',
                  response: { type: 'batch', result: { step_results, step_errors } },
                });
              } else if (item.type === 'close') {
                closed = true;
                results.push({ type: 'ok', response: { type: 'close' } });
              }
            }
            return Response.json({ baton: closed ? null : 'test-baton', results });
          },
          bindings: {
            APP_ENV: 'preview',
            FRONTEND_ORIGINS: origin,
            TURSO_DATABASE_URL: 'libsql://test-not-contacted.example.com',
            TURSO_AUTH_TOKEN: 'test-not-a-real-token',
            PASSWORD_PEPPER: pepper,
            R2_ACCOUNT_ID: '00000000000000000000000000000000',
            R2_BUCKET: 'test-not-contacted',
            R2_ACCESS_KEY_ID: 'test-not-a-real-key',
            R2_SECRET_ACCESS_KEY: 'test-not-a-real-secret',
            REGISTRATION_ENABLED: 'false',
          },
          ratelimits: {
            API_LIMITER: { namespace_id: '2001', simple: { limit: 500, period: 60 } },
            AUTH_LIMITER: { namespace_id: '2002', simple: { limit: 500, period: 60 } },
          },
        },
        {
          name: 'cl-sender',
          modules: true,
          compatibilityDate: '2026-11-17',
          script: `
            export default {
              async fetch(req, env) {
                const payload = await req.json();
                const body = payload.bytes ? new Uint8Array(payload.bytes) : payload.text;
                const fwd = new Request(payload.url, {
                  method: payload.method || 'POST',
                  headers: payload.headers,
                  body,
                });
                return env.TARGET.fetch(fwd);
              }
            };
          `,
          serviceBindings: { TARGET: 'test-worker' },
        },
      ],
    }),
  );
  try {
    // 1. Health, security headers, HEAD, and CORS/Origin checks
    const r = await mf.dispatchFetch('https://worker.example/api/health');
    assert.equal(r.status, 200, await r.clone().text());
    const healthText = await r.text();
    assert.equal(JSON.parse(healthText).status, 'ok');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(r.headers.get('x-powered-by'), null);
    assert.equal(r.headers.get('access-control-allow-origin'), null);
    assert.equal(r.headers.get('vary'), 'Origin');
    assert.match(r.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/i);

    const headRes = await mf.dispatchFetch('https://worker.example/api/health', {
      method: 'HEAD',
      headers: { Origin: origin },
    });
    assert.equal(headRes.status, 200);
    assert.equal(headRes.headers.get('access-control-allow-origin'), origin);
    assert.equal(headRes.headers.get('content-length'), String(Buffer.byteLength(healthText)));
    assert.equal(await headRes.text(), '');

    const preflight = await mf.dispatchFetch('https://worker.example/api/songs', {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
    assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
    assert.equal(preflight.headers.get('access-control-max-age'), '600');
    assert.equal(
      preflight.headers.get('access-control-allow-methods'),
      'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    );

    const deniedOrigin = await mf.dispatchFetch('https://worker.example/api/health', {
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(deniedOrigin.status, 403);
    assert.equal(deniedOrigin.headers.get('access-control-allow-origin'), null);
    assert.equal((await deniedOrigin.json()).error.code, 'ORIGIN_DENIED');

    const missingOriginPost = await mf.dispatchFetch('https://worker.example/api/auth/logout', {
      method: 'POST',
    });
    assert.equal(missingOriginPost.status, 403);
    assert.equal((await missingOriginPost.json()).error.code, 'ORIGIN_REQUIRED');

    // 2. Valid/invalid login, cookie attributes, session expiry, logout & revocation
    const loginRes = await mf.dispatchFetch('https://worker.example/api/auth/login', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: '  FIXTUREADMIN ', password }),
    });
    assert.equal(loginRes.status, 200);
    const setCookie = loginRes.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /^__Host-karaoke_session=[A-Za-z0-9_-]{43};/);
    assert.match(setCookie, /;\s*Max-Age=86400(?:;|$)/);
    assert.match(setCookie, /;\s*Path=\/(?:;|$)/);
    assert.match(setCookie, /;\s*Expires=[^;]+GMT(?:;|$)/);
    assert.match(setCookie, /;\s*HttpOnly(?:;|$)/);
    assert.match(setCookie, /;\s*Secure(?:;|$)/);
    assert.match(setCookie, /;\s*SameSite=None(?:;|$)/);
    const adminCookie = setCookie.split(';')[0];

    for (const badLogin of [
      { login: 'fixtureadmin', password: 'wrong-password' },
      { login: 'unknownuser', password },
      { login: 'inactiveuser', password },
      { login: 'legacyuser', password },
    ]) {
      const badRes = await mf.dispatchFetch('https://worker.example/api/auth/login', {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify(badLogin),
      });
      assert.equal(badRes.status, 401);
      assert.equal((await badRes.json()).error.code, 'INVALID_CREDENTIALS');
    }

    // Valid session lookup (including whitespace around cookie segments)
    const meRes = await mf.dispatchFetch('https://worker.example/api/auth/me', {
      headers: { Origin: origin, Cookie: `other=1;  ${adminCookie}  ; theme=dark` },
    });
    assert.equal(meRes.status, 200);
    assert.equal((await meRes.json()).user.username, 'fixtureadmin');

    // Duplicate cookie where first is invalid must be rejected
    const dupCookieRes = await mf.dispatchFetch('https://worker.example/api/auth/me', {
      headers: {
        Origin: origin,
        Cookie: `__Host-karaoke_session=invalid; ${adminCookie}`,
      },
    });
    assert.equal(dupCookieRes.status, 401);

    // Session expiry rejection
    const userLoginRes = await mf.dispatchFetch('https://worker.example/api/auth/login', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: 'fixtureuser', password }),
    });
    const tempCookie = userLoginRes.headers.get('set-cookie').split(';')[0];
    await db.execute({ sql: 'UPDATE sessions SET expires_at=0 WHERE user_id=?', args: [userId] });
    const expiredRes = await mf.dispatchFetch('https://worker.example/api/auth/me', {
      headers: { Origin: origin, Cookie: tempCookie },
    });
    assert.equal(expiredRes.status, 401);

    // Re-login user for route permission tests
    const userLogin2 = await mf.dispatchFetch('https://worker.example/api/auth/login', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: 'fixtureuser', password }),
    });
    const userCookie = userLogin2.headers.get('set-cookie').split(';')[0];

    // 3. JSON body edge cases: malformed, strict primitives, compression, charsets, UTF-8, oversized & inaccurate Content-Length
    const assertReachedWorkerError = async (res, expectedStatus, expectedCode) => {
      assert.equal(res.status, expectedStatus);
      const reqId = res.headers.get('x-request-id') ?? '';
      assert.match(reqId, /^[0-9a-f-]{36}$/i);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      const body = await res.json();
      assert.equal(body.requestId, reqId);
      assert.equal(body.error?.code, expectedCode);
      return body;
    };

    for (const badBody of ['{bad', '"primitive"', '123']) {
      const badJsonRes = await mf.dispatchFetch('https://worker.example/api/auth/login', {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: badBody,
      });
      await assertReachedWorkerError(badJsonRes, 400, 'INVALID_JSON');
    }

    const nonJsonTypeRes = await mf.dispatchFetch('https://worker.example/api/auth/login', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'text/plain' },
      body: JSON.stringify({ login: 'fixtureadmin', password }),
    });
    await assertReachedWorkerError(nonJsonTypeRes, 400, 'VALIDATION_ERROR');

    // Unsupported charsets & encodings must return explicit 415 client errors (never 500)
    for (const contentType of [
      'application/json; charset=iso-8859-1',
      'application/json; charset=utf-16',
      'application/json; charset=',
    ]) {
      const badCharsetRes = await mf.dispatchFetch('https://worker.example/api/auth/login', {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': contentType },
        body: JSON.stringify({ login: 'fixtureadmin', password }),
      });
      await assertReachedWorkerError(badCharsetRes, 415, 'UNSUPPORTED_CHARSET');
    }

    for (const badEnc of ['lz4', 'gzip, br']) {
      const badEncodingRes = await mf.dispatchFetch('https://worker.example/api/auth/login', {
        method: 'POST',
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          'Content-Encoding': badEnc,
        },
        body: JSON.stringify({ login: 'fixtureadmin', password }),
      });
      await assertReachedWorkerError(badEncodingRes, 415, 'UNSUPPORTED_ENCODING');
    }

    // Valid uppercase quoted charset on +json subtype
    const plusJsonRes = await mf.dispatchFetch('https://worker.example/api/auth/login', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/problem+json; charset="UTF-8"' },
      body: JSON.stringify({ login: 'fixtureadmin', password }),
    });
    assert.equal(plusJsonRes.status, 200);
    assert.equal((await plusJsonRes.json()).user.username, 'fixtureadmin');

    // Genuinely compressed JSON bodies (wire size smaller than padded JSON, and decompressed <= 64 KB)
    const compressibleLoginJson = Buffer.from(
      JSON.stringify({ login: '   ' + ' '.repeat(120) + 'fixtureadmin   ', password }),
    );
    assert.ok(compressibleLoginJson.byteLength > 150);
    const compressedEncodings = [
      ['gzip', zlib.gzipSync],
      ['deflate', zlib.deflateSync],
      ['br', zlib.brotliCompressSync],
    ];
    if ('zstdCompressSync' in zlib) {
      compressedEncodings.push(['zstd', zlib.zstdCompressSync]);
    }
    for (const [enc, compress] of compressedEncodings) {
      const wireBody = compress(compressibleLoginJson);
      assert.ok(wireBody.byteLength < compressibleLoginJson.byteLength);
      const compRes = await mf.dispatchFetch('https://worker.example/api/auth/login', {
        method: 'POST',
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          'Content-Encoding': enc,
        },
        body: wireBody,
      });
      assert.equal(compRes.status, 200, `${enc} compressed login failed`);
      assert.equal((await compRes.json()).user.username, 'fixtureadmin');
    }

    // Corrupted compressed payload must return 400 INVALID_JSON (not 500)
    const corruptGzipRes = await mf.dispatchFetch('https://worker.example/api/auth/login', {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
      },
      body: JSON.stringify({ login: 'fixtureadmin', password }),
    });
    await assertReachedWorkerError(corruptGzipRes, 400, 'INVALID_JSON');

    // Compressed decompression bombs (small compressed wire body, > 64 KB decompressed) -> 413 BODY_TOO_LARGE
    const largePayload = Buffer.from(JSON.stringify({ login: 'x'.repeat(70000), password: 'x' }));
    for (const [enc, compress] of compressedEncodings) {
      const compressedBomb = compress(largePayload);
      assert.ok(compressedBomb.byteLength < 8192, `${enc} compressed bomb should be small on wire`);
      const bombRes = await mf.dispatchFetch('https://worker.example/api/auth/login', {
        method: 'POST',
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          'Content-Encoding': enc,
        },
        body: compressedBomb,
      });
      await assertReachedWorkerError(bombRes, 413, 'BODY_TOO_LARGE');
    }

    // Invalid UTF-8 bytes transmitted directly over real local HTTP socket AND via dispatchFetch must reach Worker -> 400 INVALID_JSON
    const invalidUtf8Payload = Buffer.concat([
      Buffer.from('{"login":"'),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('","password":"fixture-only-password"}'),
    ]);
    const truncatedUtf8Payload = Buffer.concat([
      Buffer.from('{"login":"'),
      Buffer.from([0xe2, 0x82]),
      Buffer.from('","password":"fixture-only-password"}'),
    ]);
    const workerHttpUrl = await mf.ready;
    const sendRawHttp = (rawBody, extraHeaders = {}) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          new URL('/api/auth/login', workerHttpUrl),
          {
            method: 'POST',
            headers: {
              Origin: origin,
              'Content-Type': 'application/json',
              'Content-Length': String(rawBody.byteLength),
              ...extraHeaders,
            },
          },
          (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
              resolve({
                status: res.statusCode,
                headers: res.headers,
                body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
              });
            });
          },
        );
        req.on('error', reject);
        req.end(rawBody);
      });

    for (const badUtf8 of [invalidUtf8Payload, truncatedUtf8Payload]) {
      const httpRes = await sendRawHttp(badUtf8);
      assert.equal(httpRes.status, 400);
      assert.match(httpRes.headers['x-request-id'] ?? '', /^[0-9a-f-]{36}$/i);
      assert.equal(httpRes.headers['cache-control'], 'no-store');
      assert.equal(httpRes.body.requestId, httpRes.headers['x-request-id']);
      assert.equal(httpRes.body.error.code, 'INVALID_JSON');

      const gzipUtf8Res = await mf.dispatchFetch('https://worker.example/api/auth/login', {
        method: 'POST',
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
        },
        body: zlib.gzipSync(badUtf8),
      });
      await assertReachedWorkerError(gzipUtf8Res, 400, 'INVALID_JSON');
    }

    // Valid multi-byte UTF-8 character ('€' = E2 82 AC) split across chunks must decode cleanly
    const splitUtf8Chunks = [
      new Uint8Array([...Buffer.from('{"login":"user'), 0xe2, 0x82]),
      new Uint8Array([0xac, ...Buffer.from('","password":"wrong-password"}')]),
    ];
    const splitUtf8Res = await mf.dispatchFetch('https://worker.example/api/auth/login', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: new ReadableStream({
        pull(controller) {
          const next = splitUtf8Chunks.shift();
          if (next) controller.enqueue(next);
          else controller.close();
        },
      }),
      duplex: 'half',
    });
    await assertReachedWorkerError(splitUtf8Res, 401, 'INVALID_CREDENTIALS');

    const oversizedWithLength = await mf.dispatchFetch('https://worker.example/api/auth/login', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: largePayload,
    });
    await assertReachedWorkerError(oversizedWithLength, 413, 'BODY_TOO_LARGE');

    // Streamed oversized body without Content-Length (Transfer-Encoding: chunked)
    const chunks = [
      new TextEncoder().encode('{"login":"' + 'a'.repeat(40000)),
      new TextEncoder().encode('b'.repeat(30000) + '","password":"x"}'),
    ];
    const oversizedStreamRes = await mf.dispatchFetch('https://worker.example/api/auth/login', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: new ReadableStream({
        pull(controller) {
          const next = chunks.shift();
          if (next) controller.enqueue(next);
          else controller.close();
        },
      }),
      duplex: 'half',
    });
    await assertReachedWorkerError(oversizedStreamRes, 413, 'BODY_TOO_LARGE');

    // Inaccurate Content-Length: verify dispatchFetch fails client-side, while cl-sender delivers it into the Worker
    const smallLoginText = JSON.stringify({ login: 'fixtureadmin', password });
    await assert.rejects(
      mf.dispatchFetch('https://worker.example/api/auth/login', {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json', 'Content-Length': '500' },
        body: smallLoginText,
      }),
    );

    const clSender = await mf.getWorker('cl-sender');
    const sendViaServiceBinding = (headers, textOrBytes) =>
      clSender.fetch('https://sender.example/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://worker.example/api/auth/login',
          headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
          ...(typeof textOrBytes === 'string'
            ? { text: textOrBytes }
            : { bytes: Array.from(textOrBytes) }),
        }),
      });

    for (const [badCl, expectedStatus, expectedCode] of [
      ['5', 400, 'INVALID_BODY_LENGTH'],
      ['500', 400, 'INVALID_BODY_LENGTH'],
      ['70000', 413, 'BODY_TOO_LARGE'],
      ['-1', 400, 'INVALID_CONTENT_LENGTH'],
      ['abc', 400, 'INVALID_CONTENT_LENGTH'],
    ]) {
      const mismatchRes = await sendViaServiceBinding({ 'Content-Length': badCl }, smallLoginText);
      await assertReachedWorkerError(mismatchRes, expectedStatus, expectedCode);
    }

    // Compressed request with inaccurate wire Content-Length must still reach Worker and fail 400 INVALID_BODY_LENGTH
    const gzLogin = zlib.gzipSync(compressibleLoginJson);
    const badCompressedCl = await sendViaServiceBinding(
      {
        'Content-Encoding': 'gzip',
        'Content-Length': String(gzLogin.byteLength + 50),
      },
      gzLogin,
    );
    await assertReachedWorkerError(badCompressedCl, 400, 'INVALID_BODY_LENGTH');

    // Compressed request with accurate wire Content-Length (< decompressed length) must succeed
    const okCompressedCl = await sendViaServiceBinding(
      {
        'Content-Encoding': 'gzip',
        'Content-Length': String(gzLogin.byteLength),
      },
      gzLogin,
    );
    assert.equal(okCompressedCl.status, 200);
    assert.equal((await okCompressedCl.json()).user.username, 'fixtureadmin');

    // 4. Authentication & Admin authorization across routes + Upload/R2/Range/Download
    for (const [method, path] of [
      ['GET', '/api/songs'],
      ['POST', '/api/songs'],
      ['GET', '/api/playlists'],
      ['GET', '/api/favorites'],
      ['GET', '/api/performances'],
    ]) {
      const unauth = await mf.dispatchFetch('https://worker.example' + path, {
        method,
        headers: { Origin: origin },
      });
      assert.equal(unauth.status, 401, `${method} ${path} must require auth`);
    }

    const userCreateSong = await mf.dispatchFetch('https://worker.example/api/songs', {
      method: 'POST',
      headers: { Origin: origin, Cookie: userCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Song', artist: 'Artist', durationMs: 4000 }),
    });
    assert.equal(userCreateSong.status, 403);
    assert.equal((await userCreateSong.json()).error.code, 'FORBIDDEN');

    const adminCreateSong = await mf.dispatchFetch('https://worker.example/api/songs', {
      method: 'POST',
      headers: { Origin: origin, Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Worker Song', artist: 'Worker Artist', durationMs: 4000 }),
    });
    assert.equal(adminCreateSong.status, 201);
    const songId = (await adminCreateSong.json()).data.id;

    const audioBytes = new TextEncoder().encode('ID3-worker-audio-fixture-bytes');
    const pkgBytes = new TextEncoder().encode(
      await readFile('docs/sample-song-package.json', 'utf8'),
    );
    for (const [kind, bytes, contentType, omitHeadLength] of [
      ['audio', audioBytes, 'audio/mpeg', true],
      ['package', pkgBytes, 'application/json', false],
    ]) {
      const upRes = await mf.dispatchFetch(`https://worker.example/api/songs/${songId}/uploads`, {
        method: 'POST',
        headers: { Origin: origin, Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, byteSize: bytes.byteLength, contentType }),
      });
      assert.equal(upRes.status, 201);
      const { uploadId, url: signedPutUrl } = await upRes.json();
      const stagingKey = decodeURIComponent(
        new URL(signedPutUrl).pathname.replace(/^\/test-not-contacted\//, ''),
      );
      r2Objects.set(stagingKey, {
        bytes,
        type: contentType,
        etag: `"etag-${kind}"`,
        omitHeadLength,
      });
      const compRes = await mf.dispatchFetch(
        `https://worker.example/api/songs/${songId}/uploads/complete`,
        {
          method: 'POST',
          headers: { Origin: origin, Cookie: adminCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ uploadId }),
        },
      );
      assert.equal(compRes.status, 200);
      assert.equal(heads.get(stagingKey), 1);
    }

    const pubRes = await mf.dispatchFetch(`https://worker.example/api/songs/${songId}/publish`, {
      method: 'POST',
      headers: { Origin: origin, Cookie: adminCookie },
    });
    assert.equal(pubRes.status, 200);

    const dlRes = await mf.dispatchFetch(`https://worker.example/api/songs/${songId}/download`, {
      headers: { Origin: origin, Cookie: userCookie },
    });
    assert.equal(dlRes.status, 200);
    const dlBody = await dlRes.json();
    assert.match(dlBody.audioUrl, /X-Amz-Signature=/);

    // 5. Concurrent requests isolation check
    const concurrent = await Promise.all([
      mf.dispatchFetch('https://worker.example/api/health'),
      mf.dispatchFetch('https://worker.example/api/auth/me', {
        headers: { Origin: origin, Cookie: adminCookie },
      }),
      mf.dispatchFetch('https://worker.example/api/auth/me', {
        headers: { Origin: origin, Cookie: userCookie },
      }),
      mf.dispatchFetch('https://worker.example/api/auth/me', {
        headers: { Origin: origin },
      }),
      mf.dispatchFetch('https://worker.example/api/songs?page=1&pageSize=10', {
        headers: { Origin: origin, Cookie: userCookie },
      }),
      mf.dispatchFetch('https://worker.example/api/unknown-route', {
        headers: { Origin: origin, Cookie: userCookie },
      }),
    ]);
    assert.deepEqual(
      concurrent.map((x) => x.status),
      [200, 200, 200, 401, 200, 404],
    );
    const requestIds = new Set(concurrent.map((x) => x.headers.get('x-request-id')));
    assert.equal(requestIds.size, concurrent.length);

    // 6. Logout & immediate session revocation
    const logoutRes = await mf.dispatchFetch('https://worker.example/api/auth/logout', {
      method: 'POST',
      headers: { Origin: origin, Cookie: adminCookie },
    });
    assert.equal(logoutRes.status, 204);
    assert.match(
      logoutRes.headers.get('set-cookie') ?? '',
      /^__Host-karaoke_session=; Path=\/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=None$/,
    );

    const revokedRes = await mf.dispatchFetch('https://worker.example/api/auth/me', {
      headers: { Origin: origin, Cookie: adminCookie },
    });
    assert.equal(revokedRes.status, 401);
    assert.equal((await revokedRes.json()).error.code, 'UNAUTHENTICATED');
  } finally {
    await mf.dispose();
    db.close();
  }
});

test('actual password hasher stays under a simulated hosted iteration cap (CPU not measured)', async () => {
  const configuration = unstable_readConfig({ config: 'wrangler.jsonc' });
  const directory = await mkdtemp(resolve('.worker-auth-test-'));
  let mf;
  try {
    await writeFile(
      join(directory, 'wrangler.json'),
      JSON.stringify({
        name: 'karaoke-password-test',
        main: resolve('tests/fixtures/auth-worker.ts'),
        compatibility_date: configuration.compatibility_date,
        compatibility_flags: configuration.compatibility_flags,
        alias: configuration.alias,
      }),
    );
    execFileSync(
      process.execPath,
      [
        resolve('node_modules/wrangler/bin/wrangler.js'),
        'deploy',
        '--dry-run',
        '--config',
        join(directory, 'wrangler.json'),
        '--outdir',
        join(directory, 'dist'),
      ],
      { stdio: 'pipe', timeout: 60000, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
    );
    mf = new Miniflare(
      convertV4MiniflareOptions({
        workers: [
          {
            name: 'password-worker',
            modules: true,
            scriptPath: join(directory, 'dist/auth-worker.js'),
            compatibilityDate: configuration.compatibility_date,
            compatibilityFlags: configuration.compatibility_flags,
          },
        ],
      }),
    );
    const r = await mf.dispatchFetch('https://worker.example/');
    assert.equal(r.status, 200, await r.clone().text());
    assert.deepEqual(await r.json(), {
      valid: true,
      wrong: false,
      legacy: false,
      wrongPepper: false,
      maximumIterations: 12000,
      newFormat: true,
    });
  } finally {
    await mf?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Wrangler bundle handles R2 copy XML and XML errors without DOMParser', async () => {
  const configuration = unstable_readConfig({ config: 'wrangler.jsonc' });
  const dependencies = JSON.parse(await readFile('package.json', 'utf8')).dependencies;
  assert.ok(dependencies['@aws-sdk/xml-builder'], 'XML parser must be a direct dependency');
  assert.equal(
    configuration.alias?.['@aws-sdk/xml-builder'],
    '@aws-sdk/xml-builder/dist-cjs/index.js',
  );
  // This checks the real application build produced by npm run build, too.
  assert.equal((await readFile('dist/index.js', 'utf8')).includes('new DOMParser('), false);
  const directory = await mkdtemp(resolve('.worker-r2-test-'));
  let mf;
  try {
    await writeFile(
      join(directory, 'wrangler.json'),
      JSON.stringify({
        name: 'karaoke-storage-test',
        main: resolve('tests/fixtures/r2-worker.ts'),
        compatibility_date: configuration.compatibility_date,
        compatibility_flags: configuration.compatibility_flags,
        alias: configuration.alias,
      }),
    );
    execFileSync(
      process.execPath,
      [
        resolve('node_modules/wrangler/bin/wrangler.js'),
        'deploy',
        '--dry-run',
        '--config',
        join(directory, 'wrangler.json'),
        '--outdir',
        join(directory, 'dist'),
      ],
      { stdio: 'pipe', timeout: 60000, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
    );
    mf = new Miniflare(
      convertV4MiniflareOptions({
        workers: [
          {
            name: 'storage-worker',
            modules: true,
            scriptPath: join(directory, 'dist/r2-worker.js'),
            compatibilityDate: configuration.compatibility_date,
            compatibilityFlags: configuration.compatibility_flags,
          },
        ],
      }),
    );
    const success = await (await mf.dispatchFetch('https://worker.test/success')).json();
    assert.equal(success.ok, true, JSON.stringify(success));
    assert.equal(success.domParserPresent, false);
    assert.equal(success.copied, true);
    assert.equal(success.size, 64);
    assert.deepEqual(success.body, success.prefix);
    assert.deepEqual(success.prefix.slice(0, 4), [82, 73, 70, 70]);
    assert.equal(success.calls.at(-1), 'DELETE');
    for (const path of ['forbidden', 'embedded-error']) {
      const failure = await (await mf.dispatchFetch('https://worker.test/' + path)).json();
      assert.equal(failure.ok, false);
      assert.equal(failure.errorName, 'AccessDenied', JSON.stringify(failure));
      assert.equal(failure.copied, false);
      assert.equal(failure.calls.includes('DELETE'), false);
    }
  } finally {
    await mf?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('bundled Worker completes audio and package uploads via native MEDIA_BUCKET and conditional S3 copy', async () => {
  const { convertV4MiniflareOptions } = await import('miniflare');
  const { createClient } = await import('@libsql/client');
  const { createHmac, pbkdf2Sync, randomUUID } = await import('node:crypto');
  const { readFile } = await import('node:fs/promises');

  const origin = 'https://karaoke.example.com';
  const pepper = 'fixture-only-karaoke-dedicated-pepper-32-characters';
  const password = 'fixture-only-smoke-test-password';
  const salt = Buffer.alloc(32, 9);
  const derived = pbkdf2Sync(
    createHmac('sha256', pepper).update(password).digest(),
    salt,
    12000,
    32,
    'sha256',
  );
  const encodedHash =
    '$pbkdf2-sha256$12000$' + salt.toString('hex') + '$' + derived.toString('hex');

  const db = createClient({ url: 'file::memory:' });
  await db.executeMultiple(
    await readFile(new URL('../src/Migrations/0001_initial.sql', import.meta.url), 'utf8'),
  );
  const adminId = randomUUID();
  await db.execute({
    sql: 'INSERT INTO users(id,username,email,display_name,password_hash,role,is_active,created_at) VALUES(?,?,?,?,?,?,1,?)',
    args: [adminId, 'r2admin', 'r2admin@example.com', 'R2 Admin', encodedHash, 'ADMIN', Date.now()],
  });

  const storedSqls = new Map();
  const fromHranaArg = (a) =>
    a.type === 'null' ? null : a.type === 'integer' ? Number(a.value) : a.value;
  const toHranaVal = (v) =>
    v === null || v === undefined
      ? { type: 'null' }
      : typeof v === 'number'
        ? Number.isInteger(v)
          ? { type: 'integer', value: String(v) }
          : { type: 'float', value: v }
        : typeof v === 'bigint'
          ? { type: 'integer', value: String(v) }
          : { type: 'text', value: String(v) };
  const formatExecResult = (rs) => ({
    cols: rs.columns.map((name) => ({ name, decltype: null })),
    rows: rs.rows.map((row) => rs.columns.map((col) => toHranaVal(row[col]))),
    affected_row_count: rs.rowsAffected,
    last_insert_rowid: rs.lastInsertRowid != null ? String(rs.lastInsertRowid) : null,
  });

  const s3Requests = [];
  let forceCopyPreconditionFail = false;
  let mfRef;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'r2-upload-smoke',
          modules: true,
          scriptPath: new URL('../dist/index.js', import.meta.url).pathname.replace(
            /^\/([A-Za-z]:)/,
            '$1',
          ),
          compatibilityDate: '2026-11-17',
          compatibilityFlags: ['nodejs_compat'],
          r2Buckets: { MEDIA_BUCKET: 'karaoke-media-test' },
          outboundService: async (req) => {
            const u = new URL(req.url);
            if (u.hostname.endsWith('.r2.cloudflarestorage.com')) {
              s3Requests.push({
                method: req.method,
                path: u.pathname,
                copySource: req.headers.get('x-amz-copy-source'),
                ifMatch: req.headers.get('x-amz-copy-source-if-match'),
              });
              if (req.method === 'PUT' && req.headers.has('x-amz-copy-source')) {
                const bucket = await mfRef.getR2Bucket('MEDIA_BUCKET');
                const srcKey = decodeURIComponent(
                  req.headers.get('x-amz-copy-source').replace(/^\/?karaoke-media\//, ''),
                );
                const dstKey = decodeURIComponent(u.pathname.replace(/^\/karaoke-media\//, ''));
                const obj = await bucket.get(srcKey);
                if (!obj) {
                  return new Response(
                    '<?xml version="1.0"?><Error><Code>NoSuchKey</Code></Error>',
                    {
                      status: 404,
                      headers: { 'content-type': 'application/xml' },
                    },
                  );
                }
                if (
                  forceCopyPreconditionFail ||
                  req.headers.get('x-amz-copy-source-if-match') !== obj.httpEtag
                ) {
                  return new Response(
                    '<?xml version="1.0"?><Error><Code>PreconditionFailed</Code><Message>ETag mismatch</Message></Error>',
                    { status: 412, headers: { 'content-type': 'application/xml' } },
                  );
                }
                await bucket.put(dstKey, await obj.arrayBuffer(), {
                  httpMetadata: {
                    contentType: req.headers.get('content-type') || obj.httpMetadata?.contentType,
                  },
                });
                return new Response(
                  '<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><ETag>"promoted-etag"</ETag><LastModified>2026-11-21T00:00:00.000Z</LastModified></CopyObjectResult>',
                  { status: 200, headers: { 'content-type': 'application/xml' } },
                );
              }
              throw new Error(
                'Unexpected S3 HTTP fallback when native MEDIA_BUCKET is bound: ' +
                  req.method +
                  ' ' +
                  u.href,
              );
            }

            const body = await req.json();
            const results = [];
            let closed = false;
            for (const item of body.requests) {
              if (item.type === 'store_sql') {
                storedSqls.set(item.sql_id, item.sql);
                results.push({ type: 'ok', response: { type: 'store_sql' } });
              } else if (item.type === 'close_sql') {
                storedSqls.delete(item.sql_id);
                results.push({ type: 'ok', response: { type: 'close_sql' } });
              } else if (item.type === 'execute') {
                const sql = item.stmt.sql ?? storedSqls.get(item.stmt.sql_id);
                if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) {
                  results.push({
                    type: 'ok',
                    response: {
                      type: 'execute',
                      result: {
                        cols: [],
                        rows: [],
                        affected_row_count: 0,
                        last_insert_rowid: null,
                      },
                    },
                  });
                } else {
                  const rs = await db.execute({
                    sql,
                    args: (item.stmt.args ?? []).map(fromHranaArg),
                  });
                  results.push({
                    type: 'ok',
                    response: { type: 'execute', result: formatExecResult(rs) },
                  });
                }
              } else if (item.type === 'batch') {
                const step_results = [];
                const step_errors = [];
                for (const step of item.batch.steps) {
                  if (step.condition?.type === 'not') {
                    step_results.push(null);
                    step_errors.push(null);
                    continue;
                  }
                  const sql = step.stmt.sql ?? storedSqls.get(step.stmt.sql_id);
                  if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) {
                    step_results.push({
                      cols: [],
                      rows: [],
                      affected_row_count: 0,
                      last_insert_rowid: null,
                    });
                    step_errors.push(null);
                  } else {
                    const rs = await db.execute({
                      sql,
                      args: (step.stmt.args ?? []).map(fromHranaArg),
                    });
                    step_results.push(formatExecResult(rs));
                    step_errors.push(null);
                  }
                }
                results.push({
                  type: 'ok',
                  response: { type: 'batch', result: { step_results, step_errors } },
                });
              } else if (item.type === 'close') {
                closed = true;
                results.push({ type: 'ok', response: { type: 'close' } });
              }
            }
            return Response.json({ baton: closed ? null : 'test-baton', results });
          },
          bindings: {
            APP_ENV: 'production',
            FRONTEND_ORIGINS: origin,
            TURSO_DATABASE_URL: 'libsql://test-not-contacted.turso.io',
            TURSO_AUTH_TOKEN: 'test-not-a-real-token',
            PASSWORD_PEPPER: pepper,
            R2_ACCOUNT_ID: '00000000000000000000000000000000',
            R2_BUCKET: 'karaoke-media',
            R2_ACCESS_KEY_ID: 'test-not-a-real-key',
            R2_SECRET_ACCESS_KEY: 'test-not-a-real-secret',
            REGISTRATION_ENABLED: 'false',
          },
          ratelimits: {
            API_LIMITER: { namespace_id: '3001', simple: { limit: 1200, period: 60 } },
            AUTH_LIMITER: { namespace_id: '3002', simple: { limit: 120, period: 60 } },
          },
        },
      ],
    }),
  );
  mfRef = mf;

  try {
    await mf.ready;
    const bucket = await mf.getR2Bucket('MEDIA_BUCKET');

    const loginRes = await mf.dispatchFetch(origin + '/api/auth/login', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: 'r2admin', password }),
    });
    assert.equal(loginRes.status, 200);
    const cookie = loginRes.headers.get('set-cookie').split(';')[0];

    const createRes = await mf.dispatchFetch(origin + '/api/songs', {
      method: 'POST',
      headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Worker R2 Song', artist: 'Singer', durationMs: 12000 }),
    });
    assert.equal(createRes.status, 201);
    const song = (await createRes.json()).data;

    // 1. Reserve audio upload -> verify no S3 HTTP calls and proper presigned URL shape
    const audioReserveRes = await mf.dispatchFetch(origin + `/api/songs/${song.id}/uploads`, {
      method: 'POST',
      headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'audio', contentType: 'audio/mpeg', byteSize: 64 }),
    });
    assert.equal(audioReserveRes.status, 201);
    const audioIntent = await audioReserveRes.json();
    assert.equal(s3Requests.length, 0);
    const signedPut = new URL(audioIntent.url);
    assert.equal(signedPut.pathname, `/karaoke-media/_staging/${audioIntent.uploadId}`);
    assert.equal(signedPut.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
    assert.equal(
      signedPut.searchParams.get('X-Amz-SignedHeaders'),
      'content-length;content-type;host',
    );

    const stagingAudioKey = `_staging/${audioIntent.uploadId}`;
    // 1a. Spoofed bytes rejected via native MEDIA_BUCKET.prefix() and reset to PENDING
    await bucket.put(stagingAudioKey, new Uint8Array(64).fill(0x20), {
      httpMetadata: { contentType: 'audio/mpeg' },
    });
    const spoofCompleteRes = await mf.dispatchFetch(
      origin + `/api/songs/${song.id}/uploads/complete`,
      {
        method: 'POST',
        headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId: audioIntent.uploadId }),
      },
    );
    assert.equal(spoofCompleteRes.status, 400);
    assert.equal((await spoofCompleteRes.json()).error.code, 'INVALID_FILE');
    assert.equal(s3Requests.length, 0);

    // 1b. Replace with valid MP3 bytes, fail conditional CopyObject with 412 -> upload stays retryable
    const validMp3 = new Uint8Array(64);
    Buffer.from('ID3\x03\x00').copy(validMp3);
    const putAudioObj = await bucket.put(stagingAudioKey, validMp3, {
      httpMetadata: { contentType: 'audio/mpeg' },
    });
    forceCopyPreconditionFail = true;
    const preconditionRes = await mf.dispatchFetch(
      origin + `/api/songs/${song.id}/uploads/complete`,
      {
        method: 'POST',
        headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId: audioIntent.uploadId }),
      },
    );
    assert.equal(preconditionRes.status, 500);
    assert.equal(s3Requests.length, 1);
    assert.equal(s3Requests[0].ifMatch, putAudioObj.httpEtag);
    assert.ok(
      await bucket.head(stagingAudioKey),
      'Failed promote must leave staging object for retry',
    );

    // 1c. Retry audio completion -> native head/prefix/delete + S3 CopyObjectCommand succeed
    forceCopyPreconditionFail = false;
    s3Requests.length = 0;
    const audioCompleteRes = await mf.dispatchFetch(
      origin + `/api/songs/${song.id}/uploads/complete`,
      {
        method: 'POST',
        headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId: audioIntent.uploadId }),
      },
    );
    assert.equal(audioCompleteRes.status, 200);
    const afterAudio = (await audioCompleteRes.json()).data;
    assert.equal(afterAudio.hasAudio, true);
    assert.equal(s3Requests.length, 1);
    assert.equal(s3Requests[0].method, 'PUT');
    assert.equal(s3Requests[0].copySource, `karaoke-media/${stagingAudioKey}`);
    assert.equal(s3Requests[0].ifMatch, putAudioObj.httpEtag);
    assert.equal(
      await bucket.head(stagingAudioKey),
      null,
      'Staging audio must be deleted via MEDIA_BUCKET',
    );

    // Idempotent retry hits 0 S3 calls
    s3Requests.length = 0;
    const audioRetryRes = await mf.dispatchFetch(
      origin + `/api/songs/${song.id}/uploads/complete`,
      {
        method: 'POST',
        headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId: audioIntent.uploadId }),
      },
    );
    assert.equal(audioRetryRes.status, 200);
    assert.equal(s3Requests.length, 0);

    // 2. Reserve + complete package upload using native MEDIA_BUCKET.read() and parseSongPackage()
    const pkgBytes = Buffer.from(
      JSON.stringify({
        formatVersion: 1,
        packageVersion: 1,
        durationMs: 12000,
        lyrics: [{ startMs: 0, endMs: 5000, text: 'Line 1' }],
        notes: [{ startMs: 0, endMs: 4000, midiNote: 64 }],
      }),
    );
    const pkgReserveRes = await mf.dispatchFetch(origin + `/api/songs/${song.id}/uploads`, {
      method: 'POST',
      headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'package',
        contentType: 'application/json',
        byteSize: pkgBytes.length,
      }),
    });
    assert.equal(pkgReserveRes.status, 201);
    const pkgIntent = await pkgReserveRes.json();
    const stagingPkgKey = `_staging/${pkgIntent.uploadId}`;
    const putPkgObj = await bucket.put(stagingPkgKey, pkgBytes, {
      httpMetadata: { contentType: 'application/json' },
    });

    const pkgCompleteRes = await mf.dispatchFetch(
      origin + `/api/songs/${song.id}/uploads/complete`,
      {
        method: 'POST',
        headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId: pkgIntent.uploadId }),
      },
    );
    assert.equal(pkgCompleteRes.status, 200);
    const afterPkg = (await pkgCompleteRes.json()).data;
    assert.equal(afterPkg.scoringAvailable, true);
    assert.equal(s3Requests.length, 1);
    assert.equal(s3Requests[0].ifMatch, putPkgObj.httpEtag);
    assert.equal(
      await bucket.head(stagingPkgKey),
      null,
      'Staging package must be deleted via MEDIA_BUCKET',
    );
  } finally {
    await mf.dispose();
    db.close();
  }
});

test('multi-origin production FRONTEND_ORIGINS preserves backend origin, allows deployed frontend origin, and rejects unlisted origins', async () => {
  const backendOrigin = 'https://karaoke-backend-production.marclouiegi-olino.workers.dev';
  const frontendOrigin = 'https://karaoke-frontend.example.workers.dev';
  const unlistedOrigin = 'https://unlisted.example.com';

  const configuration = unstable_readConfig({ config: 'wrangler.jsonc', env: 'production' });
  const configuredOrigins = String(configuration.vars?.FRONTEND_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  assert.equal(configuredOrigins.includes(backendOrigin), true);
  assert.equal(
    configuredOrigins.some((value) => value.endsWith('.invalid')),
    true,
    'Production FRONTEND_ORIGINS must clearly mark the unconfigured frontend origin placeholder until set',
  );

  const pepper = 'test-only-karaoke-dedicated-pepper-32-characters';
  const password = 'fixture-only-password-12345';
  const salt = Buffer.alloc(32, 7);
  const derived = pbkdf2Sync(
    createHmac('sha256', pepper).update(password).digest(),
    salt,
    12000,
    32,
    'sha256',
  );
  const encodedHash =
    '$pbkdf2-sha256$12000$' + salt.toString('hex') + '$' + derived.toString('hex');

  const db = createClient({ url: 'file::memory:' });
  await db.executeMultiple(await readFile('src/Migrations/0001_initial.sql', 'utf8'));
  await db.execute({
    sql: 'INSERT INTO users(id,username,email,display_name,password_hash,role,is_active,created_at) VALUES(?,?,?,?,?,?,?,?)',
    args: [
      randomUUID(),
      'fixtureuser',
      'fixtureuser@example.com',
      'fixtureuser',
      encodedHash,
      'USER',
      1,
      Date.now(),
    ],
  });

  const fromHranaArg = (a) =>
    a.type === 'null' ? null : a.type === 'integer' ? Number(a.value) : a.value;
  const toHranaVal = (v) =>
    v === null || v === undefined
      ? { type: 'null' }
      : typeof v === 'number'
        ? Number.isInteger(v)
          ? { type: 'integer', value: String(v) }
          : { type: 'float', value: v }
        : typeof v === 'bigint'
          ? { type: 'integer', value: String(v) }
          : { type: 'text', value: String(v) };
  const formatExecResult = (rs) => ({
    cols: rs.columns.map((name) => ({ name, decltype: null })),
    rows: rs.rows.map((row) => rs.columns.map((col) => toHranaVal(row[col]))),
    affected_row_count: rs.rowsAffected,
    last_insert_rowid: rs.lastInsertRowid != null ? String(rs.lastInsertRowid) : null,
  });

  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'test-multi-origin-worker',
          modules: true,
          scriptPath: 'dist/index.js',
          compatibilityDate: '2026-11-17',
          compatibilityFlags: ['nodejs_compat'],
          outboundService: async (req) => {
            const body = await req.json();
            const results = [];
            let closed = false;
            for (const item of body.requests) {
              if (item.type === 'execute') {
                const rs = await db.execute({
                  sql: item.stmt.sql,
                  args: (item.stmt.args ?? []).map(fromHranaArg),
                });
                results.push({
                  type: 'ok',
                  response: { type: 'execute', result: formatExecResult(rs) },
                });
              } else if (item.type === 'batch') {
                const step_results = [];
                const step_errors = [];
                for (const step of item.batch.steps) {
                  if (step.condition?.type === 'not') {
                    step_results.push(null);
                    step_errors.push(null);
                    continue;
                  }
                  const sql = step.stmt.sql;
                  if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) {
                    step_results.push({
                      cols: [],
                      rows: [],
                      affected_row_count: 0,
                      last_insert_rowid: null,
                    });
                    step_errors.push(null);
                  } else {
                    const rs = await db.execute({
                      sql,
                      args: (step.stmt.args ?? []).map(fromHranaArg),
                    });
                    step_results.push(formatExecResult(rs));
                    step_errors.push(null);
                  }
                }
                results.push({
                  type: 'ok',
                  response: { type: 'batch', result: { step_results, step_errors } },
                });
              } else {
                closed = true;
                results.push({ type: 'ok', response: { type: 'close' } });
              }
            }
            return Response.json({ baton: closed ? null : 'test-baton', results });
          },
          bindings: {
            APP_ENV: 'production',
            FRONTEND_ORIGINS: `${backendOrigin},${frontendOrigin}`,
            REGISTRATION_ENABLED: 'false',
            TURSO_DATABASE_URL: 'libsql://test-not-contacted.invalid',
            TURSO_AUTH_TOKEN: 'test-token',
            PASSWORD_PEPPER: pepper,
            R2_BUCKET: 'test-not-contacted',
            R2_ACCOUNT_ID: '00000000000000000000000000000000',
            R2_ACCESS_KEY_ID: 'test-access-key',
            R2_SECRET_ACCESS_KEY: 'test-secret-key',
          },
          ratelimits: {
            API_LIMITER: { namespace_id: '2101', simple: { limit: 500, period: 60 } },
            AUTH_LIMITER: { namespace_id: '2102', simple: { limit: 500, period: 60 } },
          },
        },
      ],
    }),
  );

  try {
    const loginRes = await mf.dispatchFetch(backendOrigin + '/api/auth/login', {
      method: 'POST',
      headers: { Origin: frontendOrigin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: 'fixtureuser', password }),
    });
    assert.equal(loginRes.status, 200);
    assert.equal(loginRes.headers.get('access-control-allow-origin'), frontendOrigin);
    const setCookie = loginRes.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /^__Host-karaoke_session=/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=None/);
    const cookiePair = setCookie.split(';', 1)[0];

    const meRes = await mf.dispatchFetch(backendOrigin + '/api/auth/me', {
      headers: { Origin: frontendOrigin, Cookie: cookiePair },
    });
    assert.equal(meRes.status, 200);
    assert.equal(meRes.headers.get('access-control-allow-origin'), frontendOrigin);

    const preservedRes = await mf.dispatchFetch(backendOrigin + '/api/health', {
      headers: { Origin: backendOrigin },
    });
    assert.equal(preservedRes.status, 200);
    assert.equal(preservedRes.headers.get('access-control-allow-origin'), backendOrigin);

    const deniedRes = await mf.dispatchFetch(backendOrigin + '/api/auth/login', {
      method: 'POST',
      headers: { Origin: unlistedOrigin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: 'fixtureuser', password }),
    });
    assert.equal(deniedRes.status, 403);
    assert.equal((await deniedRes.json()).error.code, 'ORIGIN_DENIED');

    const logoutRes = await mf.dispatchFetch(backendOrigin + '/api/auth/logout', {
      method: 'POST',
      headers: { Origin: frontendOrigin, Cookie: cookiePair },
    });
    assert.equal(logoutRes.status, 204);
  } finally {
    await mf.dispose();
    db.close();
  }
});
