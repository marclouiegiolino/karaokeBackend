import { test } from 'node:test';
import assert from 'node:assert/strict';
import { R2FileStorage } from '../src/Modules/Services/R2FileStorage.js';
import { loadConfiguration } from '../src/Main/Configuration.js';

const config = loadConfiguration({
  TURSO_DATABASE_URL: 'file::memory:',
  R2_ACCOUNT_ID: '0'.repeat(32),
  R2_BUCKET: 'test',
  R2_ACCESS_KEY_ID: 'fake-not-a-real-key',
  R2_SECRET_ACCESS_KEY: 'fake-not-a-real-secret',
});

test('Worker R2 binding handles metadata, conditional ranged reads and deletion', async () => {
  const calls: Array<{ method: string; key: string; options?: unknown }> = [];
  const object = {
    key: '_staging/test.wav',
    size: 4,
    etag: 'fixture-etag',
    httpEtag: '"fixture-etag"',
    httpMetadata: { contentType: 'audio/wav', contentEncoding: 'identity' },
  };
  const bodyObject = (bytes: Uint8Array) => ({
    ...object,
    size: bytes.length,
    body: {},
    bytes: async () => bytes,
  });
  const bucket = {
    head: async (key: string) => {
      calls.push({ method: 'head', key });
      return object;
    },
    get: async (key: string, options?: unknown) => {
      calls.push({ method: 'get', key, options });
      const ranged = (options as { range?: { length: number } } | undefined)?.range;
      return bodyObject(
        ranged
          ? new Uint8Array([82, 73, 70, 70]).slice(0, ranged.length)
          : new Uint8Array([1, 2, 3, 4]),
      );
    },
    delete: async (key: string) => {
      calls.push({ method: 'delete', key });
    },
  } as unknown as R2Bucket;
  const storage = new R2FileStorage(config, fetch, bucket);

  const info = await storage.head('_staging/test.wav');
  assert.deepEqual(info, {
    byteSize: 4,
    contentType: 'audio/wav',
    etag: '"fixture-etag"',
    sizeSource: 'head',
    contentEncoding: 'identity',
  });
  assert.deepEqual(
    await storage.prefix('_staging/test.wav', 2, info.etag),
    new Uint8Array([82, 73]),
  );
  assert.deepEqual(await storage.read('_staging/test.wav', 4, info), new Uint8Array([1, 2, 3, 4]));
  await storage.remove('_staging/test.wav');

  assert.deepEqual(calls, [
    { method: 'head', key: '_staging/test.wav' },
    {
      method: 'get',
      key: '_staging/test.wav',
      options: {
        range: { offset: 0, length: 2 },
        onlyIf: { etagMatches: 'fixture-etag' },
      },
    },
    {
      method: 'get',
      key: '_staging/test.wav',
      options: { onlyIf: { etagMatches: 'fixture-etag' } },
    },
    { method: 'delete', key: '_staging/test.wav' },
  ]);
});

test('Worker R2 binding rejects package reads above the configured validation limit before GET', async () => {
  let getCalled = false;
  const bucket = {
    head: async () => null,
    get: async () => {
      getCalled = true;
      return null;
    },
    delete: async () => undefined,
  } as unknown as R2Bucket;
  const storage = new R2FileStorage(config, fetch, bucket);

  await assert.rejects(
    storage.read('oversized.json', 10, {
      byteSize: 11,
      contentType: 'application/json',
      etag: '"fixture-etag"',
    }),
    /exceeds validation limit/,
  );
  assert.equal(getCalled, false);
});
