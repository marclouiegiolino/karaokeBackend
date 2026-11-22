import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runR2Check } from '../scripts/test-r2.mjs';
const origin = 'http://localhost:3000';
function fake({
  preflightDenied = false,
  getCorrupt = false,
  getFail = false,
  cleanupFail = false,
  metadataType = 'application/json',
  metadataSizeOffset = 0,
} = {}) {
  const objects = new Map();
  let uploads = 0;
  const deleted = [];
  const key = (url) => new URL(url).pathname.slice(1);
  const storage = {
    uploadUrl: async (k) =>
      'https://test.invalid/' + k + '?X-Amz-SignedHeaders=content-type%3Bcontent-length%3Bhost',
    downloadUrl: async (k) => 'https://test.invalid/' + k,
    head: async (k) => ({
      byteSize: objects.get(k).length + metadataSizeOffset,
      contentType: metadataType,
      etag: 'test-etag',
    }),
    promote: async (a, b) => {
      objects.set(b, objects.get(a));
    },
    read: async (k) => objects.get(k),
    remove: async (k) => {
      deleted.push(k);
      if (cleanupFail) throw Error('delete failed');
      objects.delete(k);
    },
  };
  const request = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    const headers = { 'access-control-allow-origin': origin };
    if (method === 'OPTIONS')
      return new Response(null, {
        status: preflightDenied ? 403 : 204,
        headers: {
          ...headers,
          'access-control-allow-methods': 'GET,HEAD,PUT',
          'access-control-allow-headers': 'Content-Type',
        },
      });
    if (method === 'PUT') {
      uploads++;
      objects.set(key(url), options.body);
      return new Response(null, { status: 200, headers });
    }
    if (getFail) return new Response(null, { status: 403, headers });
    const bytes = objects.get(key(url));
    if (options.headers?.Range)
      return new Response(bytes.slice(0, 16), {
        status: 206,
        headers: {
          ...headers,
          'content-range': `bytes 0-15/${bytes.length}`,
          'access-control-expose-headers': 'Content-Range, ETag',
        },
      });
    return new Response(getCorrupt ? new Uint8Array([0]) : bytes, { headers });
  };
  return { storage, request, objects, deleted, uploads: () => uploads, log: () => {} };
}
test('full R2 check verifies signed routes, range and copy, then removes temporary objects', async () => {
  const f = fake();
  const r = await runR2Check({ ...f, origin });
  assert.equal(r.passed, 7);
  assert.equal(f.objects.size, 0);
  assert.equal(f.deleted.length, 2);
  assert.ok(f.deleted.every((k) => k.startsWith('_staging/_connection-tests/')));
});
test('CORS preflight failure creates no temporary objects', async () => {
  const f = fake({ preflightDenied: true });
  await assert.rejects(runR2Check({ ...f, origin }), /preflight/);
  assert.equal(f.uploads(), 0);
  assert.equal(f.deleted.length, 0);
});
test('download failure still cleans up the uploaded test object', async () => {
  const f = fake({ getFail: true });
  await assert.rejects(runR2Check({ ...f, origin }), /download/);
  assert.equal(f.objects.size, 0);
  assert.equal(f.deleted.length, 1);
});
test('incorrect downloaded bytes are rejected and cleaned up', async () => {
  const f = fake({ getCorrupt: true });
  await assert.rejects(runR2Check({ ...f, origin }), /contents do not match/);
  assert.equal(f.objects.size, 0);
});
test('cleanup errors prevent a false success result', async () => {
  const f = fake({ cleanupFail: true });
  await assert.rejects(runR2Check({ ...f, origin }), /cleanup failed/);
  assert.equal(f.deleted.length, 2);
});

test('content-type mismatches identify the actual type and still clean up', async () => {
  const f = fake({ metadataType: 'application/octet-stream' });
  const logs = [];
  await assert.rejects(
    runR2Check({ ...f, origin, log: (line) => logs.push(line) }),
    /Stored content type differs.*application\/octet-stream/,
  );
  assert.ok(
    logs.some((line) => line.includes('Upload metadata:') && line.includes('actualContentType')),
  );
  assert.equal(f.objects.size, 0);
});

test('size mismatches are reported separately from content type', async () => {
  const f = fake({ metadataSizeOffset: 1 });
  await assert.rejects(runR2Check({ ...f, origin }), /Stored byte size differs/);
  assert.equal(f.objects.size, 0);
});
