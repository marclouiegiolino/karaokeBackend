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
function metadataTransport({
  length,
  range = 'bytes 0-0/84',
  etag = '"test-etag"',
}: { length?: string; range?: string; etag?: string } = {}) {
  const seen: Request[] = [];
  const transport = async (input: RequestInfo | URL) => {
    const r = input as Request;
    seen.push(r);
    assert.equal(r.headers.get('accept-encoding'), 'identity');
    assert.ok(r.headers.get('authorization')?.startsWith('AWS4-HMAC-SHA256 '));
    if (r.method === 'HEAD') {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (etag) headers.etag = etag;
      if (length !== undefined) headers['content-length'] = length;
      return new Response(null, { status: 200, headers });
    }
    assert.equal(r.headers.get('range'), 'bytes=0-0');
    assert.equal(r.headers.get('if-match'), '"test-etag"');
    return new Response(new Uint8Array([123]), {
      status: 206,
      headers: {
        'content-type': 'application/json',
        'content-length': '1',
        'content-range': range,
        etag,
      },
    });
  };
  return { seen, transport: transport as typeof fetch };
}

test('actual AWS SDK reads an identity-encoded HEAD object length', async () => {
  const f = metadataTransport({ length: '84' });
  const result = await new R2FileStorage(config, f.transport).head('test.json');
  assert.equal(result.byteSize, 84);
  assert.equal(result.sizeSource, 'head');
  assert.equal(f.seen.length, 1);
});

test('a missing HEAD length is recovered from a validated one-byte Content-Range', async () => {
  const f = metadataTransport();
  const result = await new R2FileStorage(config, f.transport).head('test.json');
  assert.equal(result.byteSize, 84);
  assert.equal(result.sizeSource, 'range');
  assert.equal(f.seen.length, 2);
});

test('a known empty object stays zero rather than inventing a nonzero length', async () => {
  const f = metadataTransport({ length: '0' });
  const result = await new R2FileStorage(config, f.transport).head('empty.json');
  assert.equal(result.byteSize, 0);
  assert.equal(f.seen.length, 1);
});

test('unverifiable range size is rejected instead of defaulting to zero', async () => {
  const f = metadataTransport({ range: 'bytes 0-0/*' });
  await assert.rejects(
    new R2FileStorage(config, f.transport).head('test.json'),
    /could not be verified/,
  );
});

test('missing object ETags are rejected before conditional-copy operations', async () => {
  const f = metadataTransport({ length: '84', etag: '' });
  await assert.rejects(
    new R2FileStorage(config, f.transport).head('test.json'),
    /ETag is unavailable/,
  );
  assert.equal(f.seen.length, 1);
});
