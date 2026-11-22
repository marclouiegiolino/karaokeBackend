import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as zlib from 'node:zlib';
import request from 'supertest';
import { readFile } from 'node:fs/promises';
import { fixture, origin } from './helpers.js';
import { createApp } from '../src/app.js';
import { migrate } from '../scripts/migration-runner.js';
import { loadConfiguration } from '../src/Main/Configuration.js';
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(() => {
  f.db.close();
});
const songInput = { title: 'Practice Song', artist: 'Original Artist', durationMs: 4000 };
async function draft() {
  const r = await request(f.app)
    .post('/api/songs')
    .set('Origin', origin)
    .set('Cookie', f.admin.cookie)
    .send(songInput);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data;
}
async function published() {
  const s = await draft();
  await f.db.execute({
    sql: "UPDATE songs SET status='PUBLISHED',audio_key='audio-test',package_key='package-test' WHERE id=?",
    args: [s.id],
  });
  return s;
}
const result = (songId: string) => ({
  id: crypto.randomUUID(),
  songId,
  packageVersion: 1,
  scoringVersion: '1.0.0',
  pitch: 90,
  timing: 84,
  coverage: 80,
  keyShift: 0,
  tempo: 1,
  startedAt: Date.now() - 10000,
  finishedAt: Date.now() - 1000,
});

test('health is public, has a request ID, and does not reveal infrastructure', async () => {
  const r = await request(f.app).get('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'ok');
  assert.ok(r.headers['x-request-id']);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['x-powered-by'], undefined);
});
test('API requires authentication and rejects inactive or expired sessions', async () => {
  assert.equal((await request(f.app).get('/api/songs')).status, 401);
  await f.db.execute({
    sql: 'UPDATE sessions SET expires_at=0 WHERE user_id=?',
    args: [f.alice.user.id],
  });
  assert.equal((await request(f.app).get('/api/songs').set('Cookie', f.alice.cookie)).status, 401);
  await f.db.execute({ sql: 'UPDATE users SET is_active=0 WHERE id=?', args: [f.bob.user.id] });
  assert.equal((await request(f.app).get('/api/songs').set('Cookie', f.bob.cookie)).status, 401);
});
test('authorization rechecks account changes without a cached role or active session', async () => {
  const lookup = () => request(f.app).get('/api/auth/me').set('Cookie', f.admin.cookie);
  assert.equal((await lookup()).status, 200);
  await f.db.execute({ sql: "UPDATE users SET role='USER' WHERE id=?", args: [f.admin.user.id] });
  const denied = await request(f.app)
    .post('/api/songs')
    .set('Origin', origin)
    .set('Cookie', f.admin.cookie)
    .send(songInput);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'FORBIDDEN');
  assert.equal(denied.body.requestId, denied.headers['x-request-id']);
  await f.db.execute({ sql: 'UPDATE users SET is_active=0 WHERE id=?', args: [f.admin.user.id] });
  const inactive = await lookup();
  assert.equal(inactive.status, 401);
  assert.equal(inactive.body.error.code, 'UNAUTHENTICATED');
  assert.equal(inactive.headers['cache-control'], 'no-store');
});
test('database outages remain sanitized 500 errors instead of being mistaken for invalid credentials', async (t) => {
  const logs: string[] = [];
  t.mock.method(console, 'error', (message: string) => logs.push(message));
  t.mock.method(f.d.users, 'findByLogin', async () => {
    throw new Error('fixture-only-private-database-message');
  });
  t.mock.method(f.d.sessions, 'authenticateToken', async () => {
    throw new Error('fixture-only-private-database-message');
  });
  const login = await request(f.app)
    .post('/api/auth/login')
    .set('Origin', origin)
    .send({ login: 'admin', password: 'any-password' });
  const me = await request(f.app).get('/api/auth/me').set('Cookie', f.admin.cookie);
  for (const r of [login, me]) {
    assert.equal(r.status, 500);
    assert.equal(r.body.error.code, 'INTERNAL_ERROR');
    assert.equal(r.body.requestId, r.headers['x-request-id']);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['set-cookie'], undefined);
    assert.equal(JSON.stringify(r.body).includes('private-database-message'), false);
  }
  assert.equal(logs.length, 2);
  assert.ok(logs.every((line) => JSON.parse(line).event === 'request_failed'));
  assert.equal(logs.join('').includes('private-database-message'), false);
});
test('CORS and origin checks reject cross-site and missing-origin mutations', async () => {
  const foreign = await request(f.app)
    .post('/api/auth/logout')
    .set('Origin', 'https://evil.example');
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers['access-control-allow-origin'], undefined);
  assert.equal((await request(f.app).post('/api/auth/logout')).status, 403);
  const options = await request(f.app)
    .options('/api/songs')
    .set('Origin', origin)
    .set('Access-Control-Request-Method', 'POST');
  assert.equal(options.status, 204);
  assert.equal(options.headers['access-control-allow-origin'], origin);
  assert.equal(options.headers['access-control-allow-credentials'], 'true');
});
test('registration, login and logout hash secrets and never expose password hashes', async () => {
  const input = {
    username: 'Singer',
    email: 'singer@example.com',
    displayName: 'Singer',
    password: 'A long unique example password 123!',
  };
  let r = await request(f.app)
    .post('/api/auth/register')
    .set('Origin', origin)
    .send({ ...input, role: 'ADMIN' });
  assert.equal(r.status, 400);
  r = await request(f.app).post('/api/auth/register').set('Origin', origin).send(input);
  assert.equal(r.status, 201);
  assert.equal(r.body.user.role, 'USER');
  assert.equal(r.body.user.password_hash, undefined);
  const cookie = r.headers['set-cookie'][0].split(';')[0];
  assert.match(r.headers['set-cookie'][0], /HttpOnly/);
  const row = (
    await f.db.execute({
      sql: 'SELECT password_hash FROM users WHERE id=?',
      args: [r.body.user.id],
    })
  ).rows[0]!;
  assert.match(String(row.password_hash), /^\$pbkdf2-sha256\$12000\$/);
  const session = (
    await f.db.execute({
      sql: 'SELECT token_hash FROM sessions WHERE user_id=?',
      args: [r.body.user.id],
    })
  ).rows[0]!;
  assert.notEqual(session.token_hash, cookie.split('=')[1]);
  assert.equal((await request(f.app).get('/api/auth/me').set('Cookie', cookie)).status, 200);
  assert.equal(
    (await request(f.app).post('/api/auth/logout').set('Origin', origin).set('Cookie', cookie))
      .status,
    204,
  );
  assert.equal((await request(f.app).get('/api/auth/me').set('Cookie', cookie)).status, 401);
  assert.equal(
    (
      await request(f.app)
        .post('/api/auth/login')
        .set('Origin', origin)
        .send({ login: 'singer', password: 'wrong' })
    ).status,
    401,
  );
  assert.equal(
    (
      await request(f.app)
        .post('/api/auth/login')
        .set('Origin', origin)
        .send({ login: 'SINGER', password: input.password })
    ).status,
    200,
  );
});
test('public registration is disabled when configured off', async () => {
  f.d.config.REGISTRATION_ENABLED = false;
  const r = await request(f.app).post('/api/auth/register').set('Origin', origin).send({
    username: 'singer',
    email: 'x@example.com',
    displayName: 'Singer',
    password: 'Long example password for test',
  });
  assert.equal(r.status, 403);
});
test('regular users cannot create songs; unpublished songs stay private', async () => {
  assert.equal(
    (
      await request(f.app)
        .post('/api/songs')
        .set('Origin', origin)
        .set('Cookie', f.alice.cookie)
        .send(songInput)
    ).status,
    403,
  );
  const s = await draft();
  assert.equal(
    (
      await request(f.app)
        .get('/api/songs/' + s.id)
        .set('Cookie', f.alice.cookie)
    ).status,
    404,
  );
  const list = await request(f.app).get('/api/songs?drafts=true').set('Cookie', f.alice.cookie);
  assert.equal(list.body.data.length, 0);
  assert.equal(
    (
      await request(f.app)
        .post('/api/songs/' + s.id + '/publish')
        .set('Origin', origin)
        .set('Cookie', f.admin.cookie)
    ).status,
    409,
  );
});
test('song search uses SQL parameters, limits pages, and escapes wildcard input', async () => {
  await published();
  const r = await request(f.app)
    .get('/api/songs')
    .query({ search: "%' OR 1=1 --" })
    .set('Cookie', f.alice.cookie);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.length, 0);
  assert.equal(
    (await request(f.app).get('/api/songs?pageSize=100000').set('Cookie', f.alice.cookie)).status,
    400,
  );
});
test('upload completion scopes the lookup to its song before claiming the upload', async () => {
  const owner = await draft();
  const other = await draft();
  const intent = await f.d.songService.upload(owner.id, {
    kind: 'audio',
    contentType: 'audio/mpeg',
    byteSize: 32,
  });
  for (const [songId, expected] of [
    [other.id, 'Upload not found'],
    [crypto.randomUUID(), 'Song not found'],
  ]) {
    const result = await request(f.app)
      .post(`/api/songs/${songId}/uploads/complete`)
      .set('Origin', origin)
      .set('Cookie', f.admin.cookie)
      .send({ uploadId: intent.uploadId });
    assert.equal(result.status, 404);
    assert.equal(result.body.error.message, expected);
  }
  assert.equal((await f.d.songs.getUpload(intent.uploadId))?.status, 'PENDING');
});
test('upload completion validates files, publishes immutable copies, and is idempotent', async () => {
  const song = await draft();
  const audio = new TextEncoder().encode('ID3fake-test-only-mp3-header');
  const pkg = await readFile(new URL('../docs/sample-song-package.json', import.meta.url), 'utf8');
  for (const [kind, bytes, type] of [
    ['audio', audio, 'audio/mpeg'],
    ['package', new TextEncoder().encode(pkg), 'application/json'],
  ] as const) {
    const intent = await request(f.app)
      .post(`/api/songs/${song.id}/uploads`)
      .set('Origin', origin)
      .set('Cookie', f.admin.cookie)
      .send({ kind, byteSize: bytes.length, contentType: type });
    assert.equal(intent.status, 201, JSON.stringify(intent.body));
    const upload = (await f.d.songs.getUpload(intent.body.uploadId))!;
    f.storage.put(upload.staging_key, bytes, type);
    let complete = await request(f.app)
      .post(`/api/songs/${song.id}/uploads/complete`)
      .set('Origin', origin)
      .set('Cookie', f.admin.cookie)
      .send({ uploadId: upload.id });
    assert.equal(complete.status, 200, JSON.stringify(complete.body));
    assert.ok(f.storage.objects.has(upload.final_key));
    assert.ok(!f.storage.objects.has(upload.staging_key));
    complete = await request(f.app)
      .post(`/api/songs/${song.id}/uploads/complete`)
      .set('Origin', origin)
      .set('Cookie', f.admin.cookie)
      .send({ uploadId: upload.id });
    assert.equal(complete.status, 200);
  }
  assert.equal(
    (
      await request(f.app)
        .post(`/api/songs/${song.id}/publish`)
        .set('Origin', origin)
        .set('Cookie', f.admin.cookie)
    ).status,
    200,
  );
  const download = await request(f.app)
    .get(`/api/songs/${song.id}/download`)
    .set('Cookie', f.alice.cookie);
  assert.equal(download.status, 200);
  assert.match(download.body.audioUrl, /signed=true/);
  assert.equal(
    (
      await request(f.app)
        .post(`/api/songs/${song.id}/uploads`)
        .set('Origin', origin)
        .set('Cookie', f.admin.cookie)
        .send({ kind: 'cover', contentType: 'image/png', byteSize: 100 })
    ).status,
    409,
  );
  const budget = (await f.db.execute('SELECT * FROM storage_budget')).rows[0]!;
  assert.equal(budget.reserved_bytes, 0);
  assert.ok(Number(budget.used_bytes) > 0);
});
test('spoofed content and oversized uploads are rejected', async () => {
  const song = await draft();
  assert.equal(
    (
      await request(f.app)
        .post(`/api/songs/${song.id}/uploads`)
        .set('Origin', origin)
        .set('Cookie', f.admin.cookie)
        .send({ kind: 'audio', contentType: 'audio/mpeg', byteSize: 20000001 })
    ).status,
    400,
  );
  const intent = await request(f.app)
    .post(`/api/songs/${song.id}/uploads`)
    .set('Origin', origin)
    .set('Cookie', f.admin.cookie)
    .send({ kind: 'audio', contentType: 'audio/mpeg', byteSize: 4 });
  const u = (await f.d.songs.getUpload(intent.body.uploadId))!;
  f.storage.put(u.staging_key, 'fake', 'audio/mpeg');
  assert.equal(
    (
      await request(f.app)
        .post(`/api/songs/${song.id}/uploads/complete`)
        .set('Origin', origin)
        .set('Cookie', f.admin.cookie)
        .send({ uploadId: u.id })
    ).status,
    400,
  );
  assert.equal(f.storage.objects.has(u.final_key), false);
});
test('storage reservations enforce the budget and release expired reservations', async () => {
  const song = await draft();
  await f.db.execute('UPDATE storage_budget SET limit_bytes=10');
  const route = `/api/songs/${song.id}/uploads`;
  assert.equal(
    (
      await request(f.app)
        .post(route)
        .set('Origin', origin)
        .set('Cookie', f.admin.cookie)
        .send({ kind: 'audio', contentType: 'audio/mpeg', byteSize: 11 })
    ).status,
    409,
  );
  const first = await request(f.app)
    .post(route)
    .set('Origin', origin)
    .set('Cookie', f.admin.cookie)
    .send({ kind: 'audio', contentType: 'audio/mpeg', byteSize: 10 });
  assert.equal(first.status, 201);
  await f.db.execute({
    sql: 'UPDATE uploads SET expires_at=0 WHERE id=?',
    args: [first.body.uploadId],
  });
  const second = await request(f.app)
    .post(route)
    .set('Origin', origin)
    .set('Cookie', f.admin.cookie)
    .send({ kind: 'audio', contentType: 'audio/mpeg', byteSize: 10 });
  assert.equal(second.status, 201);
  assert.equal(
    (await f.db.execute('SELECT reserved_bytes FROM storage_budget')).rows[0]!.reserved_bytes,
    10,
  );
});
test('playlist ownership is enforced and duplicate additions are safe', async () => {
  const song = await published();
  const created = await request(f.app)
    .post('/api/playlists')
    .set('Origin', origin)
    .set('Cookie', f.alice.cookie)
    .send({ name: 'My songs' });
  assert.equal(created.status, 201);
  const id = created.body.data.id;
  assert.equal(
    (
      await request(f.app)
        .get('/api/playlists/' + id)
        .set('Cookie', f.bob.cookie)
    ).status,
    404,
  );
  assert.equal(
    (
      await request(f.app)
        .delete('/api/playlists/' + id)
        .set('Origin', origin)
        .set('Cookie', f.bob.cookie)
    ).status,
    404,
  );
  for (let i = 0; i < 2; i++)
    assert.equal(
      (
        await request(f.app)
          .post(`/api/playlists/${id}/songs`)
          .set('Origin', origin)
          .set('Cookie', f.alice.cookie)
          .send({ songId: song.id })
      ).status,
      204,
    );
  const playlist = await request(f.app)
    .get('/api/playlists/' + id)
    .set('Cookie', f.alice.cookie);
  assert.equal(playlist.body.data.songs.length, 1);
});
test('favorites remain private and repeated additions do not duplicate rows', async () => {
  const song = await published();
  for (let i = 0; i < 2; i++)
    assert.equal(
      (
        await request(f.app)
          .put('/api/favorites/' + song.id)
          .set('Origin', origin)
          .set('Cookie', f.alice.cookie)
      ).status,
      204,
    );
  assert.equal(
    (await request(f.app).get('/api/favorites').set('Cookie', f.alice.cookie)).body.data.length,
    1,
  );
  assert.equal(
    (await request(f.app).get('/api/favorites').set('Cookie', f.bob.cookie)).body.data.length,
    0,
  );
});
test('offline sync accepts retries once, calculates total, and rejects conflicting IDs', async () => {
  const song = await published(),
    payload = result(song.id);
  let r = await request(f.app)
    .post('/api/performances/sync')
    .set('Origin', origin)
    .set('Cookie', f.alice.cookie)
    .send(payload);
  assert.equal(r.status, 201);
  assert.equal(r.body.performance.total, 87);
  assert.equal(r.body.performance.verification, 'device-reported');
  r = await request(f.app)
    .post('/api/performances/sync')
    .set('Origin', origin)
    .set('Cookie', f.alice.cookie)
    .send(payload);
  assert.equal(r.status, 200);
  assert.equal(r.body.created, false);
  assert.equal(
    (
      await request(f.app)
        .post('/api/performances/sync')
        .set('Origin', origin)
        .set('Cookie', f.alice.cookie)
        .send({ ...payload, pitch: 100 })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(f.app)
        .post('/api/performances/sync')
        .set('Origin', origin)
        .set('Cookie', f.bob.cookie)
        .send(payload)
    ).status,
    409,
  );
  assert.equal((await f.db.execute('SELECT COUNT(*) AS n FROM performances')).rows[0]!.n, 1);
});
test('sync allows archived downloaded songs but rejects drafts, invalid versions and invalid scores', async () => {
  const song = await published();
  await f.d.songs.status(song.id, 'ARCHIVED');
  assert.equal(
    (
      await request(f.app)
        .post('/api/performances/sync')
        .set('Origin', origin)
        .set('Cookie', f.alice.cookie)
        .send(result(song.id))
    ).status,
    201,
  );
  for (const payload of [
    { ...result(song.id), pitch: 101 },
    { ...result(song.id), scoringVersion: 'fake' },
  ])
    assert.equal(
      (
        await request(f.app)
          .post('/api/performances/sync')
          .set('Origin', origin)
          .set('Cookie', f.alice.cookie)
          .send(payload)
      ).status,
      400,
    );
  assert.equal(
    (
      await request(f.app)
        .post('/api/performances/sync')
        .set('Origin', origin)
        .set('Cookie', f.alice.cookie)
        .send({ ...result(song.id), packageVersion: 2 })
    ).status,
    409,
  );
  const draftSong = await draft();
  assert.equal(
    (
      await request(f.app)
        .post('/api/performances/sync')
        .set('Origin', origin)
        .set('Cookie', f.alice.cookie)
        .send(result(draftSong.id))
    ).status,
    409,
  );
});
test('rate limiter rejects requests and body parsing handles invalid or excessive JSON', async () => {
  const limited = createApp({
    ...f.d,
    limiters: {
      api: { limit: async () => ({ success: false }) },
      auth: { limit: async () => ({ success: false }) },
    },
  });
  assert.equal((await request(limited).get('/api/health')).status, 429);
  assert.equal(
    (
      await request(f.app)
        .post('/api/auth/login')
        .set('Origin', origin)
        .set('Content-Type', 'application/json')
        .send('{bad')
    ).status,
    400,
  );
  assert.equal(
    (
      await request(f.app)
        .post('/api/auth/login')
        .set('Origin', origin)
        .send({ login: 'x'.repeat(70000), password: 'x' })
    ).status,
    413,
  );
});
test('Node HTTP path supports compressed JSON with 64 KB decompressed cap and explicit encoding/charset/UTF-8 errors', async () => {
  const server = http.createServer(f.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const sendNode = (body: Uint8Array, headers: Record<string, string>) =>
    new Promise<{ status: number; body: Record<string, any> }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: addr.port,
          path: '/api/songs',
          method: 'POST',
          headers: {
            Origin: origin,
            Cookie: f.admin.cookie,
            'Content-Type': 'application/json',
            'Content-Length': String(body.byteLength),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            });
          });
        },
      );
      req.on('error', reject);
      req.end(body);
    });

  try {
    const validPayload = Buffer.from(JSON.stringify(songInput));
    for (const [enc, compress] of [
      ['gzip', zlib.gzipSync],
      ['deflate', zlib.deflateSync],
      ['br', zlib.brotliCompressSync],
    ] as const) {
      const r = await sendNode(compress(validPayload), { 'Content-Encoding': enc });
      assert.equal(r.status, 201, `${enc} node JSON failed`);
      assert.equal(r.body.data.title, songInput.title);
    }

    const hugePayload = Buffer.from(
      JSON.stringify({ title: 'x'.repeat(70000), artist: 'a', durationMs: 1 }),
    );
    const bombRes = await sendNode(zlib.gzipSync(hugePayload), { 'Content-Encoding': 'gzip' });
    assert.equal(bombRes.status, 413);
    assert.equal(bombRes.body.error.code, 'BODY_TOO_LARGE');

    const badEncoding = await sendNode(validPayload, { 'Content-Encoding': 'lz4' });
    assert.equal(badEncoding.status, 415);
    assert.equal(badEncoding.body.error.code, 'UNSUPPORTED_ENCODING');

    const badCharset = await sendNode(validPayload, {
      'Content-Type': 'application/json; charset=iso-8859-1',
    });
    assert.equal(badCharset.status, 415);
    assert.equal(badCharset.body.error.code, 'UNSUPPORTED_CHARSET');

    const badUtf8 = await sendNode(
      Buffer.concat([Buffer.from('{"title":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]),
      {},
    );
    assert.equal(badUtf8.status, 400);
    assert.equal(badUtf8.body.error.code, 'INVALID_JSON');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});
test('migrations can be rerun without losing data and enforce foreign keys', async () => {
  await migrate(f.db);
  assert.equal((await f.db.execute('SELECT COUNT(*) AS n FROM users')).rows[0]!.n, 3);
  await assert.rejects(
    f.db.execute({
      sql: 'INSERT INTO favorites(user_id,song_id,created_at) VALUES(?,?,?)',
      args: ['missing', 'missing', Date.now()],
    }),
  );
});
test('production configuration rejects placeholder origins and missing credentials', () => {
  assert.throws(() =>
    loadConfiguration({
      APP_ENV: 'production',
      FRONTEND_ORIGINS: 'https://configure.invalid',
      TURSO_DATABASE_URL: 'libsql://test.turso.io',
    }),
  );
  assert.throws(() =>
    loadConfiguration({
      APP_ENV: 'production',
      FRONTEND_ORIGINS: 'https://karaoke.example.com',
      TURSO_DATABASE_URL: 'file:local.db',
    }),
  );
});

test('malformed scoring packages are rejected before publication', async () => {
  const song = await draft(),
    bad = '{not valid json';
  const intent = await request(f.app)
    .post(`/api/songs/${song.id}/uploads`)
    .set('Origin', origin)
    .set('Cookie', f.admin.cookie)
    .send({ kind: 'package', contentType: 'application/json', byteSize: bad.length });
  const u = (await f.d.songs.getUpload(intent.body.uploadId))!;
  f.storage.put(u.staging_key, bad, 'application/json');
  const r = await request(f.app)
    .post(`/api/songs/${song.id}/uploads/complete`)
    .set('Origin', origin)
    .set('Cookie', f.admin.cookie)
    .send({ uploadId: u.id });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'INVALID_PACKAGE');
  assert.equal(f.storage.objects.has(u.final_key), false);
});

test('R2 signing binds upload length and does not add an empty-body checksum', async () => {
  const { R2FileStorage } = await import('../src/Modules/Services/R2FileStorage.js');
  const c = loadConfiguration({
    TURSO_DATABASE_URL: 'file::memory:',
    R2_ACCOUNT_ID: '0'.repeat(32),
    R2_BUCKET: 'test',
    R2_ACCESS_KEY_ID: 'fake-not-a-real-key',
    R2_SECRET_ACCESS_KEY: 'fake-not-a-real-secret',
  });
  const url = new URL(await new R2FileStorage(c).uploadUrl('_staging/test', 'audio/mpeg', 4));
  assert.ok(url.searchParams.get('X-Amz-SignedHeaders')?.includes('content-length'));
  assert.ok(url.searchParams.get('X-Amz-SignedHeaders')?.includes('content-type'));
  assert.equal(
    [...url.searchParams.keys()].some((k) => k.toLowerCase().includes('checksum')),
    false,
  );
});

test('archiving is blocked while an asset upload is pending', async () => {
  const song = await draft();
  await request(f.app)
    .post(`/api/songs/${song.id}/uploads`)
    .set('Origin', origin)
    .set('Cookie', f.admin.cookie)
    .send({ kind: 'audio', contentType: 'audio/mpeg', byteSize: 10 });
  assert.equal(
    (
      await request(f.app)
        .post(`/api/songs/${song.id}/archive`)
        .set('Origin', origin)
        .set('Cookie', f.admin.cookie)
    ).status,
    409,
  );
});

test('a failed completion removes an uncommitted canonical copy and allows a safe retry', async () => {
  const song = await draft(),
    bytes = new TextEncoder().encode('ID3test-audio');
  const intent = await f.d.songService.upload(song.id, {
    kind: 'audio',
    contentType: 'audio/mpeg',
    byteSize: bytes.length,
  });
  const u = (await f.d.songs.getUpload(intent.uploadId))!;
  f.storage.put(u.staging_key, bytes, 'audio/mpeg');
  const complete = f.d.songs.complete.bind(f.d.songs);
  f.d.songs.complete = async () => {
    throw new Error('simulated commit failure');
  };
  await assert.rejects(f.d.songService.complete(song.id, u.id));
  assert.equal(f.storage.objects.has(u.final_key), false);
  assert.equal((await f.d.songs.getUpload(u.id))!.status, 'PENDING');
  f.d.songs.complete = complete;
  await f.d.songService.complete(song.id, u.id);
  assert.ok(f.storage.objects.has(u.final_key));
  const budget = (await f.db.execute('SELECT * FROM storage_budget')).rows[0]!;
  assert.equal(budget.reserved_bytes, 0);
  assert.equal(budget.used_bytes, bytes.length);
});

test('a lost commit acknowledgement preserves the committed asset without double counting', async () => {
  const song = await draft(),
    bytes = new TextEncoder().encode('ID3test-audio');
  const intent = await f.d.songService.upload(song.id, {
    kind: 'audio',
    contentType: 'audio/mpeg',
    byteSize: bytes.length,
  });
  const u = (await f.d.songs.getUpload(intent.uploadId))!;
  f.storage.put(u.staging_key, bytes, 'audio/mpeg');
  const complete = f.d.songs.complete.bind(f.d.songs);
  f.d.songs.complete = async (upload) => {
    await complete(upload);
    throw new Error('simulated acknowledgement loss');
  };
  await f.d.songService.complete(song.id, u.id);
  assert.ok(f.storage.objects.has(u.final_key));
  assert.equal((await f.d.songs.getUpload(u.id))!.status, 'COMPLETE');
  assert.equal(
    (await f.db.execute('SELECT used_bytes FROM storage_budget')).rows[0]!.used_bytes,
    bytes.length,
  );
});
