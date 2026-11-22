import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export class R2CheckError extends Error {}
const required = (ok, message) => {
  if (!ok) throw new R2CheckError(message);
};
const equalBytes = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
const listHeader = (response, name) =>
  (response.headers.get(name) ?? '').split(',').map((x) => x.trim().toLowerCase());
const checkOrigin = (response, origin) =>
  required(
    response.headers.get('access-control-allow-origin') === origin,
    'R2 CORS did not allow the configured frontend origin.',
  );

/** Exercises the backend's real storage adapter. The request function is injectable for tests. */
export async function runR2Check({ storage, origin, request = fetch, log = console.log }) {
  required(
    new URL(origin).origin === origin,
    'Use an exact frontend origin without a trailing slash.',
  );
  const id = randomUUID();
  const source = `_staging/_connection-tests/${id}-source.json`;
  const destination = `_staging/_connection-tests/${id}-copy.json`;
  const bytes = new TextEncoder().encode(
    JSON.stringify({ purpose: 'karaoke-r2-connection-test', id }),
  );
  const contentType = 'application/json';
  const cleanup = new Set();
  let problem;
  const passes = [];
  const pass = (label) => {
    passes.push(label);
    log('PASS: ' + label);
  };
  try {
    const putUrl = await storage.uploadUrl(source, contentType, bytes.length);
    const signedHeaders = new URL(putUrl).searchParams.get('X-Amz-SignedHeaders')?.split(';') ?? [];
    required(
      signedHeaders.includes('content-type'),
      'The storage adapter has not been updated: apply R2FileStorage.ts from the metadata fix ZIP.',
    );
    const preflight = await request(putUrl, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'content-type',
      },
      signal: AbortSignal.timeout(30000),
    });
    required(
      preflight.ok,
      `R2 upload preflight failed (HTTP ${preflight.status}). Check bucket CORS.`,
    );
    checkOrigin(preflight, origin);
    required(
      listHeader(preflight, 'access-control-allow-methods').includes('put'),
      'Bucket CORS must allow PUT.',
    );
    const allowedHeaders = listHeader(preflight, 'access-control-allow-headers');
    required(
      allowedHeaders.includes('content-type') || allowedHeaders.includes('*'),
      'Bucket CORS must allow Content-Type.',
    );
    pass('CORS upload preflight');

    // Track before sending: an upload could succeed even if its acknowledgement is lost.
    cleanup.add(source);
    const uploaded = await request(putUrl, {
      method: 'PUT',
      headers: { Origin: origin, 'Content-Type': contentType },
      body: bytes,
      signal: AbortSignal.timeout(30000),
    });
    required(
      uploaded.ok,
      `Signed upload failed (HTTP ${uploaded.status}). Check R2 credentials and bucket scope.`,
    );
    checkOrigin(uploaded, origin);
    pass('Signed upload');

    const getUrl = await storage.downloadUrl(source);
    const downloaded = await request(getUrl, {
      headers: { Origin: origin },
      signal: AbortSignal.timeout(30000),
    });
    required(downloaded.ok, `Signed download failed (HTTP ${downloaded.status}).`);
    checkOrigin(downloaded, origin);
    required(
      equalBytes(new Uint8Array(await downloaded.arrayBuffer()), bytes),
      'Downloaded contents do not match the uploaded test file.',
    );
    pass('Signed download and byte verification');

    const head = await storage.head(source);
    log(
      'Upload metadata: ' +
        JSON.stringify({
          expectedBytes: bytes.length,
          actualBytes: head.byteSize,
          actualSizeType: typeof head.byteSize,
          sizeSource: head.sizeSource ?? 'head',
          contentEncoding: head.contentEncoding ?? null,
          expectedContentType: contentType,
          actualContentType: head.contentType,
        }),
    );
    required(
      head.byteSize === bytes.length,
      `Stored byte size differs: expected ${bytes.length}, received ${String(head.byteSize)}.`,
    );
    required(
      head.contentType === contentType,
      `Stored content type differs: expected ${JSON.stringify(contentType)}, received ${JSON.stringify(head.contentType)}.`,
    );
    pass('Authenticated HEAD / object metadata');

    const ranged = await request(getUrl, {
      headers: { Origin: origin, Range: 'bytes=0-15' },
      signal: AbortSignal.timeout(30000),
    });
    required(
      ranged.status === 206,
      `Byte-range download returned HTTP ${ranged.status}; expected 206.`,
    );
    checkOrigin(ranged, origin);
    required(
      ranged.headers.get('content-range') === `bytes 0-15/${bytes.length}`,
      'Byte-range response has an unexpected Content-Range.',
    );
    const exposed = listHeader(ranged, 'access-control-expose-headers');
    required(
      exposed.includes('content-range') && exposed.includes('etag'),
      'Bucket CORS should expose Content-Range and ETag.',
    );
    required(
      equalBytes(new Uint8Array(await ranged.arrayBuffer()), bytes.slice(0, 16)),
      'Downloaded range does not match the test file.',
    );
    pass('Byte-range download and exposed CORS headers');

    cleanup.add(destination);
    await storage.promote(source, destination, head.etag);
    const copied = await storage.head(destination);
    required(
      copied.contentType === contentType && copied.byteSize === bytes.length,
      'Copied object lost its content type or byte size.',
    );
    required(
      equalBytes(await storage.read(destination, 4096), bytes),
      'Copied object contents differ from the original.',
    );
    pass('Conditional copy and content-type preservation');
  } catch (error) {
    problem = error;
  } finally {
    const leftovers = [];
    for (const key of cleanup) {
      try {
        await storage.remove(key);
      } catch {
        leftovers.push(key);
      }
    }
    if (leftovers.length) {
      log('Cleanup could not remove these test objects; remove them in the R2 dashboard:');
      for (const key of leftovers) log(key);
      problem ??= new R2CheckError('Test-file cleanup failed.');
    } else if (cleanup.size) pass('Temporary test-file cleanup');
  }
  if (problem) throw problem;
  return { passed: passes.length, origin };
}

async function main() {
  for (const name of ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
    const value = process.env[name]?.trim();
    required(
      value && !/^(YOUR_|PASTE_)/i.test(value),
      `Fill in ${name} in .dev.vars before running the test.`,
    );
  }
  required(
    /^[a-f0-9]{32}$/i.test(process.env.R2_ACCOUNT_ID),
    'R2_ACCOUNT_ID must be the 32-character account ID, not an endpoint URL.',
  );
  const origin =
    process.env.R2_TEST_ORIGIN ??
    process.env.FRONTEND_ORIGINS?.split(',')[0]?.trim() ??
    'http://localhost:3000';
  const { loadConfiguration } = await import('../src/Main/Configuration.ts');
  const { R2FileStorage } = await import('../src/Modules/Services/R2FileStorage.ts');
  const config = loadConfiguration({
    ...process.env,
    APP_ENV: 'development',
    TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL ?? 'file:unused.db',
  });
  console.log('R2 test: metadata-v3');
  console.log('Bucket:', config.R2_BUCKET);
  console.log('Frontend origin:', origin);
  console.log(
    'Testing one small temporary JSON file; no database records or song files will be changed.',
  );
  await runR2Check({ storage: new R2FileStorage(config), origin });
  console.log('R2 CONNECTION TEST PASSED');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    if (error instanceof R2CheckError) console.error('FAIL:', error.message);
    else
      console.error(
        'FAIL: R2 request failed. Error:',
        String(error.name ?? 'Unknown'),
        'HTTP:',
        error.$metadata?.httpStatusCode ?? 'unavailable',
      );
    console.error(
      'Share the PASS/FAIL and Upload metadata lines for diagnosis. Do not share .dev.vars, credentials, or signed URLs.',
    );
    process.exitCode = 1;
  });
}
