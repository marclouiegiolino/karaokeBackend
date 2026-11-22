import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBackendCheck, practiceFiles } from '../scripts/test-backend-e2e.mjs';
const origin = 'http://localhost:3000';
function fake({ badPassword = false, badCompletion = false, corruptDownload = false } = {}) {
  const assets = new Map();
  const uploads = new Map();
  const calls = [];
  const logs = [];
  let title;
  let cookie = false;
  const songId = 'e32213aa-de7a-4d9b-aa9c-16f609d47c7e';
  const remote = (kind) => 'https://testaccount.r2.cloudflarestorage.com/' + kind;
  const json = (value, status = 200, headers = {}) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  const request = async (url, options = {}) => {
    const u = new URL(url),
      headers = new Headers(options.headers),
      method = options.method ?? 'GET';
    calls.push({ url: u, method, headers });
    if (u.hostname.endsWith('.r2.cloudflarestorage.com')) {
      assert.equal(headers.has('Cookie'), false);
      if (method === 'PUT') {
        assets.set(u.pathname.slice(1), new Uint8Array(options.body));
        return new Response(null, { status: 200 });
      }
      const data = assets.get(u.pathname.slice(1));
      if (headers.has('Range')) return new Response(data.slice(0, 44), { status: 206 });
      return new Response(corruptDownload ? new Uint8Array([1]) : data);
    }
    assert.equal(headers.get('Origin'), origin);
    if (u.pathname === '/api/health') return json({ status: 'ok' });
    if (u.pathname === '/api/auth/login') {
      const body = JSON.parse(options.body);
      assert.equal(body.password, 'test-private-password');
      if (badPassword) return json({ error: { code: 'INVALID_CREDENTIALS' } }, 401);
      cookie = true;
      return json({ user: { id: 'admin', role: 'ADMIN' } }, 200, {
        'Set-Cookie': 'karaoke_session=private-test-cookie; HttpOnly; Path=/',
      });
    }
    assert.ok(cookie && headers.get('Cookie') === 'karaoke_session=private-test-cookie');
    if (u.pathname === '/api/auth/me') return json({ user: { id: 'admin', role: 'ADMIN' } });
    if (u.pathname === '/api/auth/logout') {
      cookie = false;
      return new Response(null, { status: 204 });
    }
    if (u.pathname === '/api/songs' && method === 'POST') {
      title = JSON.parse(options.body).title;
      return json({ data: { id: songId, status: 'DRAFT' } }, 201);
    }
    if (u.pathname.endsWith('/uploads') && method === 'POST') {
      const body = JSON.parse(options.body);
      const id = String(uploads.size + 1);
      uploads.set(id, body);
      return json({ method: 'PUT', url: remote(body.kind), uploadId: id }, 201);
    }
    if (u.pathname.endsWith('/uploads/complete'))
      return badCompletion
        ? json({ error: { code: 'ASSET_MISMATCH' } }, 400)
        : json({ data: { id: songId } });
    if (u.pathname.endsWith('/publish')) return json({ data: { id: songId, status: 'PUBLISHED' } });
    if (u.pathname === '/api/songs') return json({ data: [{ id: songId, title }] });
    if (u.pathname.endsWith('/download'))
      return json({
        songId,
        packageVersion: 1,
        audioUrl: remote('audio'),
        packageUrl: remote('package'),
      });
    throw Error('Unexpected fake API request');
  };
  return { request, calls, logs, log: (line) => logs.push(line) };
}
test('generated practice WAV and note package describe the same four-second exercise', () => {
  const f = practiceFiles();
  assert.equal(f.audio.toString('ascii', 0, 4), 'RIFF');
  assert.equal(f.audio.readUInt32LE(40), 22050 * 4 * 2);
  assert.equal(f.durationMs, 4000);
  assert.deepEqual(
    f.melody.notes.map((n) => n.midiNote),
    [60, 62, 64],
  );
  assert.equal(f.melody.packageVersion, 1);
});
test('complete API exercise retains only a clearly marked practice song and logs out', async () => {
  const f = fake();
  const result = await runBackendCheck({
    ...f,
    origin,
    login: 'admin',
    password: 'test-private-password',
  });
  assert.equal(result.passed, 9);
  assert.ok(result.title.startsWith('[TEST]'));
  assert.equal(f.calls.at(-1).url.pathname, '/api/auth/logout');
  const logs = f.logs.join('\n');
  assert.equal(logs.includes('test-private-password'), false);
  assert.equal(logs.includes('private-test-cookie'), false);
  assert.equal(logs.includes('r2.cloudflarestorage.com'), false);
});
test('failed login stops before creating song data', async () => {
  const f = fake({ badPassword: true });
  await assert.rejects(
    runBackendCheck({ ...f, origin, login: 'admin', password: 'test-private-password' }),
    /INVALID_CREDENTIALS/,
  );
  assert.equal(
    f.calls.some((c) => c.url.pathname === '/api/songs'),
    false,
  );
});
test('failed upload completion logs out and reports the test song for inspection', async () => {
  const f = fake({ badCompletion: true });
  await assert.rejects(
    runBackendCheck({ ...f, origin, login: 'admin', password: 'test-private-password' }),
    /ASSET_MISMATCH/,
  );
  assert.equal(f.calls.at(-1).url.pathname, '/api/auth/logout');
  assert.ok(f.logs.some((l) => l.includes('remains available for inspection')));
});
test('published download corruption fails verification and still logs out', async () => {
  const f = fake({ corruptDownload: true });
  await assert.rejects(
    runBackendCheck({ ...f, origin, login: 'admin', password: 'test-private-password' }),
    /audio bytes differ/,
  );
  assert.equal(f.calls.at(-1).url.pathname, '/api/auth/logout');
});
test('administrator credentials cannot be sent to a remote API by this local helper', async () => {
  const f = fake();
  await assert.rejects(
    runBackendCheck({
      ...f,
      baseUrl: 'https://remote.example/api',
      origin,
      login: 'admin',
      password: 'test-private-password',
    }),
    /only to a local/,
  );
  assert.equal(f.calls.length, 0);
});
