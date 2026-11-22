import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createClient } from '@libsql/client';
import { migrate } from '../scripts/migration-runner.js';
import { loadConfiguration } from '../src/Main/Configuration.js';
import { buildDependencies } from '../src/Main/Dependencies.js';
import { createApp } from '../src/app.js';
import { digest, newToken } from '../src/Security/TokenService.js';
import { FakeStorage, origin } from './helpers.js';
import {
  MAX_TRANSCRIBE_AUDIO_BYTES,
  MAX_TRANSCRIBE_DURATION_MS,
  normalizeWhisperOutput,
  TranscriptionService,
  WHISPER_MODEL,
} from '../src/Modules/Services/TranscriptionService.js';
import type { AiBinding } from '../src/Types/Environment.js';

async function transcriptionFixture(
  options: {
    ai?: AiBinding;
    aiRateLimit?: { limit: (input: { key: string }) => Promise<{ success: boolean }> };
    timeoutMs?: number;
  } = {},
) {
  const db = createClient({ url: 'file::memory:' });
  await migrate(db);
  const config = loadConfiguration({
    APP_ENV: 'development',
    TURSO_DATABASE_URL: 'file::memory:',
    FRONTEND_ORIGINS: origin,
    REGISTRATION_ENABLED: 'false',
    PASSWORD_PEPPER: 'test-only-karaoke-pepper-32-characters-minimum',
  });
  const storage = new FakeStorage();
  const allow = { limit: async () => ({ success: true }) };
  const d = buildDependencies(
    config,
    db,
    storage,
    { api: allow, auth: allow, ai: options.aiRateLimit ?? allow },
    'node',
    options.ai,
  );
  if (options.timeoutMs !== undefined) {
    d.transcription = new TranscriptionService(d.songs, storage, options.ai, options.timeoutMs);
  }

  async function createSessionUser(role: 'ADMIN' | 'USER', name: string) {
    const id = crypto.randomUUID();
    await d.users.create({
      id,
      username: name,
      email: `${name}@example.com`,
      display_name: name,
      password_hash: 'unused-session-fixture',
      role,
      is_active: 1,
      created_at: Date.now(),
    });
    const token = newToken();
    await db.execute({
      sql: 'INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)',
      args: [crypto.randomUUID(), id, digest(token), Date.now() + 3600_000, Date.now()],
    });
    return { id, cookie: `karaoke_session=${token}` };
  }

  return {
    db,
    d,
    storage,
    app: createApp(d),
    admin: await createSessionUser('ADMIN', 'admin'),
    user: await createSessionUser('USER', 'singer'),
  };
}

test('transcription route enforces admin authentication, origin checks, rate limits, and strict body validation', async () => {
  const aiCalls: unknown[] = [];
  let aiHits = 0;
  const f = await transcriptionFixture({
    ai: {
      async run(model, inputs) {
        aiCalls.push({ model, inputs });
        return { text: 'Hello world' };
      },
    },
    aiRateLimit: {
      async limit() {
        aiHits += 1;
        return { success: aiHits <= 2 };
      },
    },
  });

  const song = await f.d.songs.create(
    { title: 'Test Track', artist: 'Singer', durationMs: 15000 },
    f.admin.id,
  );

  // Unauthenticated
  const unauth = await request(f.app)
    .post(`/api/songs/${song.id}/lyrics/transcribe`)
    .set('Origin', origin)
    .send({});
  assert.equal(unauth.status, 401);

  // Regular user forbidden
  const nonAdmin = await request(f.app)
    .post(`/api/songs/${song.id}/lyrics/transcribe`)
    .set('Origin', origin)
    .set('Cookie', f.user.cookie)
    .send({});
  assert.equal(nonAdmin.status, 403);
  assert.equal(nonAdmin.body.error.code, 'FORBIDDEN');

  // Arbitrary audio URLs or unknown fields rejected
  const badBody = await request(f.app)
    .post(`/api/songs/${song.id}/lyrics/transcribe`)
    .set('Origin', origin)
    .set('Cookie', f.admin.cookie)
    .send({ audioUrl: 'https://untrusted.invalid/audio.mp3' });
  assert.equal(badBody.status, 400);
  assert.equal(badBody.body.error.code, 'VALIDATION_ERROR');

  // Admin on song without audio returns AUDIO_REQUIRED cleanly (hit #1)
  const noAudio = await request(f.app)
    .post(`/api/songs/${song.id}/lyrics/transcribe`)
    .set('Origin', origin)
    .set('Cookie', f.admin.cookie)
    .send({});
  assert.equal(noAudio.status, 409);
  assert.equal(noAudio.body.error.code, 'AUDIO_REQUIRED');

  // Hit #2 succeeds or checks audio requirement, hit #3 triggers rate limit
  await request(f.app)
    .post(`/api/songs/${song.id}/lyrics/transcribe`)
    .set('Origin', origin)
    .set('Cookie', f.admin.cookie)
    .send({});
  const limited = await request(f.app)
    .post(`/api/songs/${song.id}/lyrics/transcribe`)
    .set('Origin', origin)
    .set('Cookie', f.admin.cookie)
    .send({});
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'RATE_LIMITED');
  assert.equal(aiCalls.length, 0);
  f.db.close();
});

test('transcription scopes to song audio, enforces byte and duration bounds before R2 read, and never auto-publishes', async () => {
  const aiCalls: Array<{ model: string; inputs: Record<string, unknown> }> = [];
  const f = await transcriptionFixture({
    ai: {
      async run(model, inputs) {
        aiCalls.push({ model, inputs });
        return {
          transcription_info: { language: 'en' },
          text: 'Line one Line two',
          segments: [
            { start: 0.5, end: 3.25, text: '  Line   one ' },
            { start: 3.5, end: 8.0, text: 'Line two' },
          ],
        };
      },
    },
  });

  // 1. Over duration limit -> rejected before head/read/AI
  const tooLong = await f.d.songs.create(
    { title: 'Long Song', artist: 'Band', durationMs: MAX_TRANSCRIBE_DURATION_MS + 1000 },
    f.admin.id,
  );
  await f.db.execute({
    sql: 'UPDATE songs SET audio_key=? WHERE id=?',
    args: [`songs/${tooLong.id}/v1/audio`, tooLong.id],
  });
  let headCalls = 0;
  const origHead = f.storage.head.bind(f.storage);
  f.storage.head = async (key: string) => {
    headCalls += 1;
    return origHead(key);
  };
  const longRes = await request(f.app)
    .post(`/api/songs/${tooLong.id}/lyrics/transcribe`)
    .set('Origin', origin)
    .set('Cookie', f.admin.cookie)
    .send({});
  assert.equal(longRes.status, 400);
  assert.equal(longRes.body.error.code, 'TRANSCRIPTION_AUDIO_TOO_LONG');
  assert.equal(headCalls, 0);
  assert.equal(aiCalls.length, 0);

  // 2. Over byte limit -> rejected after head() without calling storage.read() or AI
  const tooBig = await f.d.songs.create(
    { title: 'Big File', artist: 'Band', durationMs: 60_000 },
    f.admin.id,
  );
  const bigKey = `songs/${tooBig.id}/v1/audio`;
  f.storage.objects.set(bigKey, {
    bytes: new Uint8Array(MAX_TRANSCRIBE_AUDIO_BYTES + 1),
    type: 'audio/mpeg',
  });
  await f.db.execute({ sql: 'UPDATE songs SET audio_key=? WHERE id=?', args: [bigKey, tooBig.id] });
  let readCalls = 0;
  const origRead = f.storage.read.bind(f.storage);
  f.storage.read = async (key: string, max: number) => {
    readCalls += 1;
    return origRead(key, max);
  };
  const bigRes = await request(f.app)
    .post(`/api/songs/${tooBig.id}/lyrics/transcribe`)
    .set('Origin', origin)
    .set('Cookie', f.admin.cookie)
    .send({});
  assert.equal(bigRes.status, 400);
  assert.equal(bigRes.body.error.code, 'TRANSCRIPTION_AUDIO_TOO_LARGE');
  assert.equal(readCalls, 0);
  assert.equal(aiCalls.length, 0);

  // 3. Valid bounded audio -> single base64 conversion, valid timestamps preserved, stays DRAFT
  const draftSong = await f.d.songs.create(
    { title: 'Valid Draft', artist: 'Aria', durationMs: 12_000, language: 'en' },
    f.admin.id,
  );
  const audioBytes = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x01, 0x02]);
  const validKey = `songs/${draftSong.id}/v1/audio`;
  f.storage.put(validKey, audioBytes, 'audio/mpeg');
  await f.db.execute({
    sql: 'UPDATE songs SET audio_key=? WHERE id=?',
    args: [validKey, draftSong.id],
  });

  const okRes = await request(f.app)
    .post(`/api/songs/${draftSong.id}/lyrics/transcribe`)
    .set('Origin', origin)
    .set('Cookie', f.admin.cookie)
    .send({});
  assert.equal(okRes.status, 200);
  assert.deepEqual(okRes.body.data, {
    songId: draftSong.id,
    model: WHISPER_MODEL,
    language: 'en',
    hasTimestamps: true,
    lines: [
      { text: 'Line one', startMs: 500, endMs: 3250 },
      { text: 'Line two', startMs: 3500, endMs: 8000 },
    ],
  });
  assert.equal(aiCalls.length, 1);
  assert.equal(aiCalls[0]?.model, WHISPER_MODEL);
  assert.equal(aiCalls[0]?.inputs.audio, Buffer.from(audioBytes).toString('base64'));
  assert.equal(aiCalls[0]?.inputs.task, 'transcribe');
  assert.equal(aiCalls[0]?.inputs.vad_filter, true);

  // Draft must NOT be auto-published and package_key must remain unset
  const refreshed = await f.d.songs.findById(draftSong.id);
  assert.equal(refreshed?.status, 'DRAFT');
  assert.equal(refreshed?.package_key, null);
  f.db.close();
});

test('normalizeWhisperOutput drops invalid/overlapping timestamps honestly without fabricating values', () => {
  const overlapping = normalizeWhisperOutput(
    {
      text: 'One Two',
      segments: [
        { start: 0, end: 4.0, text: 'One' },
        { start: 3.9, end: 6.0, text: 'Two' },
      ],
    },
    10_000,
  );
  assert.equal(overlapping.hasTimestamps, false);
  assert.deepEqual(overlapping.lines, [
    { text: 'One', startMs: null, endMs: null },
    { text: 'Two', startMs: null, endMs: null },
  ]);

  const textOnly = normalizeWhisperOutput(
    { text: 'First verse line\n\nSecond verse line' },
    10_000,
  );
  assert.equal(textOnly.hasTimestamps, false);
  assert.deepEqual(textOnly.lines, [
    { text: 'First verse line', startMs: null, endMs: null },
    { text: 'Second verse line', startMs: null, endMs: null },
  ]);
});

test('transcription handles malformed AI output, quota exhaustion, timeouts, and missing binding safely', async () => {
  async function runScenario(mockRun: (() => Promise<unknown>) | undefined, timeoutMs?: number) {
    const f = await transcriptionFixture({
      ai: mockRun ? { run: mockRun } : undefined,
      timeoutMs,
    });
    const song = await f.d.songs.create(
      { title: 'Err Song', artist: 'Singer', durationMs: 20_000 },
      f.admin.id,
    );
    const key = `songs/${song.id}/v1/audio`;
    f.storage.put(key, new Uint8Array([0x49, 0x44, 0x33, 0x04]), 'audio/mpeg');
    await f.db.execute({ sql: 'UPDATE songs SET audio_key=? WHERE id=?', args: [key, song.id] });
    const res = await request(f.app)
      .post(`/api/songs/${song.id}/lyrics/transcribe`)
      .set('Origin', origin)
      .set('Cookie', f.admin.cookie)
      .send({});
    f.db.close();
    return res;
  }

  const unconfigured = await runScenario(undefined);
  assert.equal(unconfigured.status, 503);
  assert.equal(unconfigured.body.error.code, 'AI_UNCONFIGURED');

  const malformed = await runScenario(async () => 'not-an-object');
  assert.equal(malformed.status, 502);
  assert.equal(malformed.body.error.code, 'AI_INVALID_RESPONSE');

  const empty = await runScenario(async () => ({ text: '   ', segments: [] }));
  assert.equal(empty.status, 422);
  assert.equal(empty.body.error.code, 'NO_LYRICS_DETECTED');

  const quota = await runScenario(async () => {
    throw Object.assign(new Error('Daily free neurons quota exceeded'), { status: 429 });
  });
  assert.equal(quota.status, 429);
  assert.equal(quota.body.error.code, 'AI_QUOTA_EXCEEDED');

  const unavailable = await runScenario(async () => {
    throw Object.assign(new Error('Upstream internal error'), { status: 503 });
  });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.error.code, 'AI_UNAVAILABLE');

  const timedOut = await runScenario(() => new Promise(() => {}), 25);
  assert.equal(timedOut.status, 504);
  assert.equal(timedOut.body.error.code, 'AI_TIMEOUT');
});
