import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { FetchHttpHandler } from '@smithy/fetch-http-handler';
import { ZodError } from 'zod';
import { loadConfiguration } from '../src/Main/Configuration.js';
import { TursoHttpDatabase } from '../src/Main/TursoHttpDatabase.js';
import { R2FileStorage } from '../src/Modules/Services/R2FileStorage.js';
import { parseSongPackage, songPackageSchema } from '../src/Modules/Song/SongPackage.js';
import { uploadSongSchema } from '../src/DTOs/Song/UploadSongRequest.js';
import { fixture, origin } from './helpers.js';

let f: Awaited<ReturnType<typeof fixture>>;

beforeEach(async () => {
  f = await fixture();
});

afterEach(() => {
  f.db.close();
});

async function createDraftSong(durationMs = 12000) {
  const res = await request(f.app)
    .post('/api/songs')
    .set('Origin', origin)
    .set('Cookie', f.admin.cookie)
    .send({ title: 'Opt Song', artist: 'Opt Artist', durationMs });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

const validPackage = (durationMs = 12000, packageVersion = 1) => ({
  formatVersion: 1 as const,
  packageVersion,
  durationMs,
  lyrics: [
    { startMs: 0, endMs: 4000, text: 'First line' },
    { startMs: 4000, endMs: 9000, text: 'Second line' },
  ],
  notes: [
    { startMs: 0, endMs: 2500, midiNote: 60 },
    { startMs: 2500, endMs: 8000, midiNote: 64 },
  ],
});

test('R2FileStorage NodeCryptoSha256 matches default S3Client signing', async () => {
  const r2Config = loadConfiguration({
    APP_ENV: 'development',
    TURSO_DATABASE_URL: 'file::memory:',
    FRONTEND_ORIGINS: origin,
    PASSWORD_PEPPER: 'test-only-karaoke-pepper-32-characters-minimum',
    R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    R2_BUCKET: 'karaoke-media',
    R2_ACCESS_KEY_ID: 'test-access-key-id',
    R2_SECRET_ACCESS_KEY: 'test-secret-access-key',
  });

  let refCopyReq: { url: string; headers: Headers } | undefined;
  const endpoint = `https://${r2Config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const makeRefClient = () =>
    new S3Client({
      region: 'auto',
      requestChecksumCalculation: 'WHEN_REQUIRED',
      endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: r2Config.R2_ACCESS_KEY_ID!,
        secretAccessKey: r2Config.R2_SECRET_ACCESS_KEY!,
      },
      requestHandler: new FetchHttpHandler({
        customFetch: async (req, init) => {
          const r = new Request(req as RequestInfo, init);
          refCopyReq = { url: r.url, headers: new Headers(r.headers) };
          return new Response(
            '<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><ETag>"promoted"</ETag></CopyObjectResult>',
            { status: 200, headers: { 'content-type': 'application/xml' } },
          );
        },
      }),
    });

  let fastCopyReq: { url: string; headers: Headers } | undefined;
  const storage = new R2FileStorage(r2Config, (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const req = new Request(input, init);
    fastCopyReq = { url: req.url, headers: new Headers(req.headers) };
    return new Response(
      '<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><ETag>"promoted"</ETag></CopyObjectResult>',
      { status: 200, headers: { 'content-type': 'application/xml' } },
    );
  }) as typeof fetch);

  // Align within the same second so X-Amz-Date and signature match bit-for-bit.
  let putMatched = false;
  let getMatched = false;
  for (let attempt = 0; attempt < 3 && (!putMatched || !getMatched); attempt++) {
    const refClient = makeRefClient();
    const fastPut = await storage.uploadUrl('_staging/u1', 'audio/mpeg', 4096);
    const refPut = await getSignedUrl(
      refClient,
      new PutObjectCommand({
        Bucket: r2Config.R2_BUCKET,
        Key: '_staging/u1',
        ContentType: 'audio/mpeg',
        ContentLength: 4096,
      }),
      { expiresIn: 300, signableHeaders: new Set(['content-type']) },
    );
    const fastGet = await storage.downloadUrl('songs/s1/v1/audio-u1');
    const refGet = await getSignedUrl(
      refClient,
      new GetObjectCommand({ Bucket: r2Config.R2_BUCKET, Key: 'songs/s1/v1/audio-u1' }),
      { expiresIn: 900 },
    );
    if (
      new URL(fastPut).searchParams.get('X-Amz-Date') ===
      new URL(refPut).searchParams.get('X-Amz-Date')
    ) {
      assert.equal(fastPut, refPut);
      putMatched = true;
    }
    if (
      new URL(fastGet).searchParams.get('X-Amz-Date') ===
      new URL(refGet).searchParams.get('X-Amz-Date')
    ) {
      assert.equal(fastGet, refGet);
      getMatched = true;
    }
  }
  assert.ok(putMatched && getMatched, 'Presigned PUT/GET URLs should match within same second');

  await storage.promote('_staging/u1', 'songs/s1/v1/audio-u1', '"src-etag"', 'audio/mpeg');
  await makeRefClient().send(
    new CopyObjectCommand({
      Bucket: r2Config.R2_BUCKET,
      Key: 'songs/s1/v1/audio-u1',
      CopySource: `${r2Config.R2_BUCKET}/_staging/u1`,
      CopySourceIfMatch: '"src-etag"',
      ContentType: 'audio/mpeg',
      MetadataDirective: 'REPLACE',
      CacheControl: 'private, max-age=86400',
    }),
  );
  assert.ok(fastCopyReq && refCopyReq);
  assert.equal(fastCopyReq.url, refCopyReq.url);
  assert.equal(
    fastCopyReq.headers.get('x-amz-copy-source'),
    refCopyReq.headers.get('x-amz-copy-source'),
  );
  assert.equal(
    fastCopyReq.headers.get('x-amz-copy-source-if-match'),
    refCopyReq.headers.get('x-amz-copy-source-if-match'),
  );
  assert.equal(fastCopyReq.headers.get('content-type'), refCopyReq.headers.get('content-type'));
  assert.equal(fastCopyReq.headers.get('cache-control'), refCopyReq.headers.get('cache-control'));
  assert.match(
    fastCopyReq.headers.get('authorization') ?? '',
    /^AWS4-HMAC-SHA256 Credential=test-access-key-id\/\d{8}\/auto\/s3\/aws4_request/,
  );
});

test('upload reservation batch preserves error precedence, budget invariants, and expiration cleanup', async () => {
  const missingRes = await request(f.app)
    .post('/api/songs/nonexistent-song/uploads')
    .set('Origin', origin)
    .set('Cookie', f.admin.cookie)
    .send({ kind: 'audio', contentType: 'text/plain', byteSize: 999999999 });
  assert.equal(missingRes.status, 404);
  assert.equal(missingRes.body.error.code, 'NOT_FOUND');

  const song = await createDraftSong();
  await f.db.execute({
    sql: "UPDATE songs SET status='PUBLISHED', audio_key='a', package_key='p' WHERE id=?",
    args: [song.id],
  });
  const immutableRes = await request(f.app)
    .post(`/api/songs/${song.id}/uploads`)
    .set('Origin', origin)
    .set('Cookie', f.admin.cookie)
    .send({ kind: 'audio', contentType: 'text/plain', byteSize: 999999999 });
  assert.equal(immutableRes.status, 409);
  assert.equal(immutableRes.body.error.code, 'IMMUTABLE_MEDIA');

  const draft = await createDraftSong();
  const invalidAssetRes = await request(f.app)
    .post(`/api/songs/${draft.id}/uploads`)
    .set('Origin', origin)
    .set('Cookie', f.admin.cookie)
    .send({ kind: 'audio', contentType: 'text/plain', byteSize: 500 });
  assert.equal(invalidAssetRes.status, 400);
  assert.equal(invalidAssetRes.body.error.code, 'INVALID_ASSET');

  const budgetAfterInvalid = await f.db.execute({
    sql: 'SELECT reserved_bytes, used_bytes FROM storage_budget WHERE id=1',
  });
  assert.equal(Number(budgetAfterInvalid.rows[0].reserved_bytes), 0);

  // Fill nearly all budget with an expired upload, then verify re-reservation succeeds only if within limit.
  await f.db.execute({ sql: 'UPDATE storage_budget SET limit_bytes=1000 WHERE id=1' });
  const r1 = await request(f.app)
    .post(`/api/songs/${draft.id}/uploads`)
    .set('Origin', origin)
    .set('Cookie', f.admin.cookie)
    .send({ kind: 'audio', contentType: 'audio/mpeg', byteSize: 800 });
  assert.equal(r1.status, 201);

  const duplicate = await request(f.app)
    .post(`/api/songs/${draft.id}/uploads`)
    .set('Origin', origin)
    .set('Cookie', f.admin.cookie)
    .send({ kind: 'audio', contentType: 'audio/mpeg', byteSize: 100 });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, 'UPLOAD_EXISTS');

  await f.db.execute({
    sql: 'UPDATE uploads SET expires_at=? WHERE id=?',
    args: [Date.now() - 1000, r1.body.uploadId],
  });

  // Still exceeds limit even after freeing expired 800 bytes -> STORAGE_BUDGET without losing consistent accounting.
  const overBudget = await request(f.app)
    .post(`/api/songs/${draft.id}/uploads`)
    .set('Origin', origin)
    .set('Cookie', f.admin.cookie)
    .send({ kind: 'audio', contentType: 'audio/mpeg', byteSize: 1200 });
  assert.equal(overBudget.status, 409);
  assert.equal(overBudget.body.error.code, 'STORAGE_BUDGET');

  const withinBudget = await request(f.app)
    .post(`/api/songs/${draft.id}/uploads`)
    .set('Origin', origin)
    .set('Cookie', f.admin.cookie)
    .send({ kind: 'audio', contentType: 'audio/mpeg', byteSize: 900 });
  assert.equal(withinBudget.status, 201);
  assert.notEqual(withinBudget.body.uploadId, r1.body.uploadId);

  const budgetAfterReclaim = await f.db.execute({
    sql: 'SELECT reserved_bytes, used_bytes FROM storage_budget WHERE id=1',
  });
  assert.equal(Number(budgetAfterReclaim.rows[0].reserved_bytes), 900);
});

test('atomic upload completion rejects wrong state without committing partial mutations', async () => {
  const song = await createDraftSong();
  const intent = await request(f.app)
    .post(`/api/songs/${song.id}/uploads`)
    .set('Origin', origin)
    .set('Cookie', f.admin.cookie)
    .send({ kind: 'audio', contentType: 'audio/mpeg', byteSize: 128 });
  assert.equal(intent.status, 201);

  const upload = (await f.d.songs.getUpload(intent.body.uploadId))!;
  // Attempting complete while still PENDING fails with UPLOAD_STATE.
  await assert.rejects(
    f.d.songs.complete(upload),
    (err: { code?: string; status?: number }) => err.code === 'UPLOAD_STATE' && err.status === 409,
  );

  // Verify atomic UPDATE ... RETURNING claimForCompletion outcomes cleanly.
  assert.equal(
    (await f.d.songs.claimForCompletion('missing-song', upload.id)).status,
    'NOT_FOUND_SONG',
  );
  assert.equal(
    (await f.d.songs.claimForCompletion(song.id, 'missing-upload')).status,
    'NOT_FOUND_UPLOAD',
  );
  const firstClaim = await f.d.songs.claimForCompletion(song.id, upload.id);
  assert.equal(firstClaim.status, 'CLAIMED');
  assert.equal(firstClaim.upload.status, 'PROCESSING');
  assert.equal(firstClaim.upload.duration_ms, 12000);
  assert.equal(firstClaim.upload.package_version, 1);
  assert.equal((await f.d.songs.claimForCompletion(song.id, upload.id)).status, 'UNAVAILABLE');

  // Change song out of DRAFT -> complete() must fail with SONG_STATE
  // AND leave uploads.status as PROCESSING + storage_budget unchanged.
  await f.db.execute({ sql: "UPDATE songs SET status='ARCHIVED' WHERE id=?", args: [song.id] });
  await assert.rejects(
    f.d.songs.complete(upload),
    (err: { code?: string; status?: number }) => err.code === 'SONG_STATE' && err.status === 409,
  );

  assert.equal((await f.d.songs.getUpload(upload.id))?.status, 'PROCESSING');
  const budget = await f.db.execute({
    sql: 'SELECT reserved_bytes, used_bytes FROM storage_budget WHERE id=1',
  });
  assert.equal(Number(budget.rows[0].reserved_bytes), 128);
  assert.equal(Number(budget.rows[0].used_bytes), 0);
});

test('fast validators match Zod acceptance and fall back cleanly to identical Zod errors', async () => {
  // uploadSongSchema._fastParse
  assert.deepEqual(
    uploadSongSchema._fastParse?.({
      kind: 'package',
      contentType: 'application/json',
      byteSize: 512,
    }),
    { kind: 'package', contentType: 'application/json', byteSize: 512 },
  );
  assert.equal(
    uploadSongSchema._fastParse?.({
      kind: 'audio',
      contentType: 'audio/mpeg',
      byteSize: 100,
      extra: true,
    }),
    undefined,
  );
  assert.equal(
    uploadSongSchema._fastParse?.({ kind: 'audio', contentType: 'audio/mpeg', byteSize: 12.5 }),
    undefined,
  );
  assert.equal(
    uploadSongSchema._fastParse?.({ kind: 'audio', contentType: '', byteSize: 100 }),
    undefined,
  );

  // parseSongPackage (both with target notes and lyrics-only empty notes array)
  const good = validPackage();
  assert.deepEqual(parseSongPackage(good), good);
  const lyricsOnly = { ...good, notes: [] };
  assert.deepEqual(parseSongPackage(lyricsOnly), lyricsOnly);
  assert.deepEqual(songPackageSchema.parse(lyricsOnly), lyricsOnly);
  for (const bad of [
    { ...good, extra: 1 },
    { ...good, formatVersion: 2 },
    { ...good, lyrics: [] },
    { ...good, lyrics: [{ startMs: 0, endMs: 1000, text: 'ok', extra: 1 }] },
    { ...good, notes: [{ startMs: 0, endMs: 1000, midiNote: 128 }] },
    { ...good, lyrics: [{ startMs: 5000, endMs: 15000, text: 'past end' }] },
    {
      ...good,
      notes: [
        { startMs: 0, endMs: 3000, midiNote: 60 },
        { startMs: 2999, endMs: 4000, midiNote: 62 },
      ],
    },
  ]) {
    assert.throws(() => parseSongPackage(bad), ZodError);
    assert.throws(() => songPackageSchema.parse(bad), ZodError);
  }

  // completeUploadBodySchema controller validation fallback
  const song = await createDraftSong();
  for (const invalidBody of [
    { uploadId: 'not-a-uuid' },
    { uploadId: '123e4567-e89b-92d3-a456-426614174000' },
    { uploadId: '123e4567-e89b-42d3-a456-426614174000', extra: true },
  ]) {
    const res = await request(f.app)
      .post(`/api/songs/${song.id}/uploads/complete`)
      .set('Origin', origin)
      .set('Cookie', f.admin.cookie)
      .send(invalidBody);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  }
});

test('all supported audio and image signatures pass while spoofed signatures fail and allow retry', async () => {
  const song = await createDraftSong();
  const validPayloads: Array<{ kind: 'audio' | 'cover'; contentType: string; header: number[] }> = [
    { kind: 'audio', contentType: 'audio/mpeg', header: [0xff, 0xfb, 0x90, 0x64] },
    {
      kind: 'audio',
      contentType: 'audio/wav',
      header: [0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45],
    },
    { kind: 'audio', contentType: 'audio/ogg', header: [0x4f, 0x67, 0x67, 0x53, 0x00, 0x02] },
    {
      kind: 'audio',
      contentType: 'audio/mp4',
      header: [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20],
    },
    {
      kind: 'cover',
      contentType: 'image/png',
      header: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    },
    {
      kind: 'cover',
      contentType: 'image/webp',
      header: [0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50],
    },
  ];

  // Put spoofed cover first -> 400 INVALID_FILE -> reset to PENDING -> replace object with JPEG -> 200.
  const coverIntent = await request(f.app)
    .post(`/api/songs/${song.id}/uploads`)
    .set('Origin', origin)
    .set('Cookie', f.admin.cookie)
    .send({ kind: 'cover', contentType: 'image/jpeg', byteSize: 32 });
  assert.equal(coverIntent.status, 201);
  const coverUpload = (await f.d.songs.getUpload(coverIntent.body.uploadId))!;
  const badBuf = new Uint8Array(32).fill(0x41);
  f.storage.put(coverUpload.staging_key, badBuf, 'image/jpeg');
  const spoofRes = await request(f.app)
    .post(`/api/songs/${song.id}/uploads/complete`)
    .set('Origin', origin)
    .set('Cookie', f.admin.cookie)
    .send({ uploadId: coverUpload.id });
  assert.equal(spoofRes.status, 400);
  assert.equal(spoofRes.body.error.code, 'INVALID_FILE');
  assert.equal((await f.d.songs.getUpload(coverUpload.id))?.status, 'PENDING');

  const jpegBuf = new Uint8Array(32);
  jpegBuf.set([0xff, 0xd8, 0xff, 0xe0]);
  f.storage.put(coverUpload.staging_key, jpegBuf, 'image/jpeg');
  const okCover = await request(f.app)
    .post(`/api/songs/${song.id}/uploads/complete`)
    .set('Origin', origin)
    .set('Cookie', f.admin.cookie)
    .send({ uploadId: coverUpload.id });
  assert.equal(okCover.status, 200);
  assert.equal(okCover.body.data.hasCover, true);

  for (const sample of validPayloads) {
    const s = await createDraftSong();
    const uRes = await request(f.app)
      .post(`/api/songs/${s.id}/uploads`)
      .set('Origin', origin)
      .set('Cookie', f.admin.cookie)
      .send({ kind: sample.kind, contentType: sample.contentType, byteSize: 32 });
    assert.equal(uRes.status, 201);
    const up = (await f.d.songs.getUpload(uRes.body.uploadId))!;
    const bytes = new Uint8Array(32);
    bytes.set(sample.header);
    f.storage.put(up.staging_key, bytes, sample.contentType);
    const done = await request(f.app)
      .post(`/api/songs/${s.id}/uploads/complete`)
      .set('Origin', origin)
      .set('Cookie', f.admin.cookie)
      .send({ uploadId: up.id });
    assert.equal(done.status, 200, JSON.stringify(done.body));
  }
});

test('R2FileStorage.prewarm and TursoHttpDatabase.prewarm run without network I/O and preserve S3 and DB behavior', async () => {
  const r2Config = loadConfiguration({
    APP_ENV: 'development',
    TURSO_DATABASE_URL: 'libsql://karaoke-test.turso.io',
    TURSO_AUTH_TOKEN: 'test-token',
    FRONTEND_ORIGINS: origin,
    PASSWORD_PEPPER: 'test-only-karaoke-pepper-32-characters-minimum',
    R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    R2_BUCKET: 'karaoke-media',
    R2_ACCESS_KEY_ID: 'test-access-key',
    R2_SECRET_ACCESS_KEY: 'test-secret-access-key-for-sigv4',
  });
  let dbFetchCalls = 0;
  const db = new TursoHttpDatabase({
    url: 'libsql://karaoke-test.turso.io',
    authToken: 'test-token',
    fetch: async () => {
      dbFetchCalls++;
      return Response.json({
        baton: null,
        results: [
          {
            type: 'ok',
            response: {
              type: 'execute',
              result: {
                cols: [{ name: 'ok', decltype: 'INTEGER' }],
                rows: [[{ type: 'integer', value: '1' }]],
                affected_row_count: 0,
                last_insert_rowid: null,
              },
            },
          },
          { type: 'ok', response: { type: 'close' } },
        ],
      });
    },
  });
  await db.prewarm();
  assert.equal(dbFetchCalls, 0);
  const postWarmExec = await db.execute('SELECT 1 AS ok');
  assert.equal(dbFetchCalls, 1);
  assert.equal(postWarmExec.rows[0]?.ok, 1);

  let s3FetchCalls = 0;
  const storage = new R2FileStorage(r2Config, (async () => {
    s3FetchCalls++;
    return new Response(
      '<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><ETag>"promoted"</ETag></CopyObjectResult>',
      { status: 200, headers: { 'content-type': 'application/xml' } },
    );
  }) as typeof fetch);
  await storage.prewarm();
  assert.equal(s3FetchCalls, 0);

  const signedPut = await storage.uploadUrl('staging/songs/1/test.json', 'application/json', 128);
  assert.match(
    signedPut,
    /^https:\/\/0123456789abcdef0123456789abcdef\.r2\.cloudflarestorage\.com\/karaoke-media\/staging\/songs\/1\/test\.json\?/,
  );
  const signedGet = await storage.downloadUrl('songs/1/v1/test.json');
  assert.match(
    signedGet,
    /^https:\/\/0123456789abcdef0123456789abcdef\.r2\.cloudflarestorage\.com\/karaoke-media\/songs\/1\/v1\/test\.json\?/,
  );
  await storage.promote('_staging/u1', 'songs/1/v1/test.json', '"etag1"', 'application/json');
  assert.equal(s3FetchCalls, 1);

  // Verify special-character key encoding parity and direct promote XML error handling (412, 403, and 200 embedded <Error>).
  const specialKey = 'songs/1/v1/track (1)!.mp3';
  const signedSpecialGet = await storage.downloadUrl(specialKey);
  assert.ok(
    signedSpecialGet.includes('/karaoke-media/songs/1/v1/track%20%281%29%21.mp3?'),
    signedSpecialGet,
  );

  for (const [status, code, msg] of [
    [412, 'PreconditionFailed', 'ETag precondition failed'],
    [403, 'AccessDenied', 'Forbidden copy'],
    [200, 'AccessDenied', 'Embedded 200 copy failure'],
  ] as const) {
    const errStorage = new R2FileStorage(
      r2Config,
      (async () =>
        new Response(`<Error><Code>${code}</Code><Message>${msg}</Message></Error>`, {
          status,
          headers: { 'content-type': 'application/xml' },
        })) as typeof fetch,
    );
    await assert.rejects(
      errStorage.promote('_staging/u1', 'songs/1/v1/test.json', '"etag1"', 'application/json'),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.name, code);
        assert.equal(err.message, msg);
        return true;
      },
    );
  }

  // Verify reserveForSong and claimForCompletion preserve all Upload fields.
  const song = await createDraftSong();
  const reserved = await f.d.songs.reserveForSong(
    song.id,
    { kind: 'audio', contentType: 'audio/mpeg', byteSize: 1024 },
    true,
  );
  const stored = await f.d.songs.getUpload(reserved.id);
  assert.deepEqual(reserved, stored);
  const claimed = await f.d.songs.claimForCompletion(song.id, reserved.id);
  assert.equal(claimed.status, 'CLAIMED');
  if (claimed.status === 'CLAIMED') {
    assert.equal(claimed.upload.id, reserved.id);
    assert.equal(claimed.upload.song_id, song.id);
    assert.equal(claimed.upload.status, 'PROCESSING');
    assert.equal(claimed.upload.song_status, 'DRAFT');
    assert.equal(claimed.upload.final_key, reserved.final_key);
    assert.equal(claimed.upload.duration_ms, song.duration_ms);
  }
});

test('generated lyrics-only package (empty notes array) completes upload and publishes through existing flow', async () => {
  const song = await createDraftSong(15000);
  const generatedLyricsOnly = {
    formatVersion: 1,
    packageVersion: 1,
    durationMs: 15000,
    lyrics: [
      { startMs: 1000, endMs: 5500, text: 'First timed lyric line' },
      { startMs: 6000, endMs: 12000, text: 'Second timed lyric line' },
    ],
    notes: [],
  };
  const pkgBytes = new TextEncoder().encode(JSON.stringify(generatedLyricsOnly));
  const pkgIntent = await request(f.app)
    .post(`/api/songs/${song.id}/uploads`)
    .set('Origin', origin)
    .set('Cookie', f.admin.cookie)
    .send({ kind: 'package', contentType: 'application/json', byteSize: pkgBytes.byteLength });
  assert.equal(pkgIntent.status, 201);
  const pkgUpload = (await f.d.songs.getUpload(pkgIntent.body.uploadId))!;
  f.storage.put(pkgUpload.staging_key, pkgBytes, 'application/json');

  const pkgDone = await request(f.app)
    .post(`/api/songs/${song.id}/uploads/complete`)
    .set('Origin', origin)
    .set('Cookie', f.admin.cookie)
    .send({ uploadId: pkgUpload.id });
  assert.equal(pkgDone.status, 200);
  assert.equal(pkgDone.body.data.scoringAvailable, true);

  const audioBytes = new Uint8Array(64);
  audioBytes.set([0x49, 0x44, 0x33, 0x03, 0x00]);
  const audIntent = await request(f.app)
    .post(`/api/songs/${song.id}/uploads`)
    .set('Origin', origin)
    .set('Cookie', f.admin.cookie)
    .send({ kind: 'audio', contentType: 'audio/mpeg', byteSize: audioBytes.byteLength });
  assert.equal(audIntent.status, 201);
  const audUpload = (await f.d.songs.getUpload(audIntent.body.uploadId))!;
  f.storage.put(audUpload.staging_key, audioBytes, 'audio/mpeg');

  const audDone = await request(f.app)
    .post(`/api/songs/${song.id}/uploads/complete`)
    .set('Origin', origin)
    .set('Cookie', f.admin.cookie)
    .send({ uploadId: audUpload.id });
  assert.equal(audDone.status, 200);

  const pub = await request(f.app)
    .post(`/api/songs/${song.id}/publish`)
    .set('Origin', origin)
    .set('Cookie', f.admin.cookie)
    .send({});
  assert.equal(pub.status, 200);
  assert.equal(pub.body.data.status, 'PUBLISHED');
});
