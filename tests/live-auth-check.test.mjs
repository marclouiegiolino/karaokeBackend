import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { runLiveAuth, readCredentials, productionOrigin } from '../scripts/test-live-auth.mjs';

const password = '  eight-plus-\u00e9-\u2665  ';
const token = 'a'.repeat(43);
const cookie = '__Host-karaoke_session=' + token;
const validCookie = cookie + '; Path=/; HttpOnly; Secure; SameSite=None';
function fixture({
  loginStatus = 200,
  textError = false,
  invalidCookie = false,
  lookupFails = false,
  keepSession = false,
} = {}) {
  const calls = [],
    logs = [];
  let revoked = false;
  const json = (data, status = 200, headers = {}) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  const request = async (url, options) => {
    const path = new URL(url).pathname;
    const headers = new Headers(options.headers);
    assert.equal(new URL(url).origin, productionOrigin);
    assert.equal(options.redirect, 'error');
    assert.equal(headers.get('Origin'), productionOrigin);
    calls.push({ path, options });
    if (path === '/api/health') return json({ status: 'ok' });
    if (path === '/api/auth/login') {
      assert.deepEqual(JSON.parse(options.body), { login: 'micaela', password });
      if (loginStatus !== 200) {
        if (textError)
          return new Response('<html>error code: 1102; ' + password + '</html>', {
            status: loginStatus,
            headers: { 'Content-Type': 'text/html', 'Cf-Ray': 'abcdef0123456789-MNL' },
          });
        return json(
          {
            error: {
              code: 'VALIDATION_ERROR',
              message: password,
              issues: [
                { path: ['password'], message: password },
                { path: [password], message: password },
              ],
            },
          },
          loginStatus,
        );
      }
      return json({ user: { id: 'test-admin', role: 'ADMIN' } }, 200, {
        'Set-Cookie': invalidCookie ? cookie + '; Path=/; HttpOnly' : validCookie,
      });
    }
    assert.equal(headers.get('Cookie'), cookie);
    if (path === '/api/auth/me') {
      if (revoked && !keepSession) return json({ error: { code: 'UNAUTHENTICATED' } }, 401);
      if (lookupFails) return json({ error: { code: 'UNAUTHENTICATED' } }, 401);
      return json({ user: { id: 'test-admin', role: 'ADMIN' } });
    }
    if (path === '/api/auth/logout') {
      revoked = true;
      return new Response(null, { status: 204 });
    }
    throw Error('Unexpected fake request');
  };
  return { request, log: (line) => logs.push(line), calls, logs };
}
test('live check validates secure cookies, account lookup and real session revocation', async () => {
  const f = fixture();
  await runLiveAuth({ ...f, login: 'micaela', password });
  assert.ok(f.logs.includes('LIVE AUTH CHECK PASSED'));
  assert.equal(f.logs.filter((line) => line.startsWith('PASS:')).length, 4);
  assert.equal(f.calls.at(-1).path, '/api/auth/me');
  const output = f.logs.join('\n');
  assert.equal(output.includes(password), false);
  assert.equal(output.includes(token), false);
});
test('HTTP 400 reports the validation field without echoing response messages or passwords', async () => {
  const f = fixture({ loginStatus: 400 });
  await assert.rejects(
    runLiveAuth({ ...f, login: 'micaela', password }),
    /HTTP 400, VALIDATION_ERROR/,
  );
  const output = f.logs.join('\n');
  assert.ok(output.includes('"validationFields":["password"]'));
  assert.equal(output.includes(password), false);
  assert.equal(f.calls.length, 2);
});
test('HTML errors retain status, response type and platform indicator without exposing the body', async () => {
  const f = fixture({ loginStatus: 500, textError: true });
  await assert.rejects(runLiveAuth({ ...f, login: 'micaela', password }), /HTTP 500.*html/);
  const output = f.logs.join('\n');
  assert.ok(output.includes('"possiblePlatformCode":"1102"'));
  assert.ok(output.includes('"cfRay":"abcdef0123456789-MNL"'));
  assert.equal(output.includes(password), false);
  assert.equal(output.includes('<html>'), false);
});
for (const options of [{ invalidCookie: true }, { lookupFails: true }, { keepSession: true }]) {
  test(
    'a failed cookie/session check does not leave its session untested: ' + JSON.stringify(options),
    async () => {
      const f = fixture(options);
      await assert.rejects(runLiveAuth({ ...f, login: 'micaela', password }));
      assert.ok(f.calls.some((call) => call.path === '/api/auth/logout'));
      assert.equal(f.logs.includes('LIVE AUTH CHECK PASSED'), false);
    },
  );
}
test('helper refuses a changed origin and never forwards credentials through a redirect', async () => {
  const f = fixture();
  await assert.rejects(
    runLiveAuth({ ...f, origin: 'https://different.example', login: 'micaela', password }),
    /exact production/,
  );
  assert.equal(f.calls.length, 0);
});
test('native fetch receives valid UTF-8 JSON and the expected byte length', async () => {
  const f = fixture();
  const failures = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const part of req) chunks.push(part);
      const body = Buffer.concat(chunks);
      if (req.url === '/api/auth/login')
        assert.equal(Number(req.headers['content-length']), body.length);
      const result = await f.request(productionOrigin + req.url, {
        method: req.method,
        headers: req.headers,
        body: body.length ? body.toString('utf8') : undefined,
        redirect: 'error',
      });
      res.writeHead(result.status, Object.fromEntries(result.headers));
      res.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      failures.push(error);
      res.writeHead(500);
      res.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const target = 'http://127.0.0.1:' + server.address().port;
  try {
    await runLiveAuth({
      login: 'micaela',
      password,
      log: () => {},
      request: (url, options) => fetch(target + new URL(url).pathname, options),
    });
    assert.deepEqual(failures, []);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
test('stdin credential parser handles BOM, split UTF-8 and password whitespace', async () => {
  const bytes = Buffer.from('\uFEFF' + JSON.stringify({ login: ' micaela ', password }));
  const value = await readCredentials(Readable.from([...bytes].map((byte) => Buffer.from([byte]))));
  assert.deepEqual(value, { login: 'micaela', password });
  await assert.rejects(readCredentials(Readable.from(['x'.repeat(8193)])), /exceeds/);
  await assert.rejects(
    readCredentials(
      Readable.from([JSON.stringify({ login: 'micaela', password: 'x'.repeat(129) })]),
    ),
    /128/,
  );
});

test('a lookup network failure is sanitized and still revokes the established session', async () => {
  const f = fixture();
  let firstLookup = true;
  const request = async (url, options) => {
    if (new URL(url).pathname === '/api/auth/me' && firstLookup) {
      firstLookup = false;
      const error = new TypeError(password);
      error.cause = { code: 'ECONNRESET', message: cookie };
      throw error;
    }
    return f.request(url, options);
  };
  await assert.rejects(runLiveAuth({ ...f, request, login: 'micaela', password }), (error) => {
    assert.match(error.message, /Session lookup connection failed: ECONNRESET/);
    assert.equal(error.message.includes(password), false);
    assert.equal(error.message.includes(token), false);
    return true;
  });
  assert.ok(f.logs.includes('PASS: Live logout and session revocation'));
});

test('native fetch refuses a login redirect without sending credentials to its destination', async () => {
  let destinationCalls = 0;
  const destination = createServer((_req, res) => {
    destinationCalls++;
    res.end('unexpected');
  });
  destination.listen(0, '127.0.0.1');
  await once(destination, 'listening');
  const server = createServer((req, res) => {
    req.resume();
    if (req.url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    } else {
      res.writeHead(307, { Location: 'http://127.0.0.1:' + destination.address().port });
      res.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await assert.rejects(
      runLiveAuth({
        login: 'micaela',
        password,
        log: () => {},
        request: (url, options) =>
          fetch('http://127.0.0.1:' + server.address().port + new URL(url).pathname, options),
      }),
      /Login connection failed/,
    );
    assert.equal(destinationCalls, 0);
  } finally {
    for (const listener of [server, destination]) {
      listener.closeAllConnections();
      await new Promise((resolve) => listener.close(resolve));
    }
  }
});
