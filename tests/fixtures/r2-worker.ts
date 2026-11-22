import { R2FileStorage } from '../../src/Modules/Services/R2FileStorage.js';
import { loadConfiguration } from '../../src/Main/Configuration.js';

// Test-only transport: every storage request is handled in memory with fake credentials.
export default {
  async fetch(request: Request) {
    const mode = new URL(request.url).pathname.slice(1);
    const calls: string[] = [];
    const bytes = new Uint8Array(64);
    bytes.set(new TextEncoder().encode('RIFF'), 0);
    bytes.set(new TextEncoder().encode('WAVE'), 8);
    let copied = false;
    const transport: typeof fetch = async (input, init) => {
      const req = new Request(input, init);
      calls.push(req.method);
      const headers = {
        'content-type': 'audio/wav',
        'content-length': String(bytes.length),
        etag: '"fixture-etag"',
      };
      if (req.method === 'HEAD') return new Response(null, { headers });
      if (req.method === 'GET') {
        const range = req.headers.get('range');
        if (range) {
          const match = /^bytes=(\d+)-(\d+)$/.exec(range)!;
          const start = Number(match[1]),
            end = Math.min(Number(match[2]), bytes.length - 1);
          return new Response(bytes.slice(start, end + 1), {
            status: 206,
            headers: {
              ...headers,
              'content-length': String(end - start + 1),
              'content-range': `bytes ${start}-${end}/${bytes.length}`,
            },
          });
        }
        return new Response(bytes, { headers });
      }
      if (req.method === 'PUT' && req.headers.has('x-amz-copy-source')) {
        if (
          req.headers.get('x-amz-copy-source-if-match') !== '"fixture-etag"' ||
          req.headers.get('content-type') !== 'audio/wav' ||
          req.headers.get('x-amz-metadata-directive') !== 'REPLACE'
        )
          throw new Error('Copy request lost its integrity or metadata conditions');
        if (mode === 'forbidden' || mode === 'embedded-error')
          return new Response(
            '<Error><Code>AccessDenied</Code><Message>Test-only denial</Message></Error>',
            {
              status: mode === 'forbidden' ? 403 : 200,
              headers: { 'content-type': 'application/xml' },
            },
          );
        copied = true;
        return new Response(
          '<CopyObjectResult><ETag>"copied"</ETag><LastModified>2026-11-17T00:00:00.000Z</LastModified></CopyObjectResult>',
          {
            headers: { 'content-type': 'application/xml' },
          },
        );
      }
      if (req.method === 'DELETE') return new Response(null, { status: 204 });
      throw new Error('Unexpected fixture request');
    };
    const config = loadConfiguration({
      APP_ENV: 'preview',
      FRONTEND_ORIGINS: 'https://karaoke.example.com',
      TURSO_DATABASE_URL: 'libsql://not-contacted.example.com',
      TURSO_AUTH_TOKEN: 'not-a-real-token',
      PASSWORD_PEPPER: 'fixture-only-karaoke-pepper-at-least-32-characters',
      R2_ACCOUNT_ID: '00000000000000000000000000000000',
      R2_BUCKET: 'not-contacted',
      R2_ACCESS_KEY_ID: 'not-a-real-key',
      R2_SECRET_ACCESS_KEY: 'not-a-real-secret',
    });
    try {
      const storage = new R2FileStorage(config, transport);
      const info = await storage.head('_staging/fixture.wav');
      const prefix = await storage.prefix('_staging/fixture.wav', 64);
      const body = await storage.read('_staging/fixture.wav', 100);
      await storage.promote('_staging/fixture.wav', 'canonical.wav', info.etag);
      await storage.remove('_staging/fixture.wav');
      return Response.json({
        ok: true,
        copied,
        size: info.byteSize,
        prefix: Array.from(prefix),
        body: Array.from(body),
        calls,
        domParserPresent: typeof (globalThis as Record<string, unknown>).DOMParser !== 'undefined',
      });
    } catch (error) {
      // Fake transport only; never include real response bodies, headers, URLs or secrets.
      return Response.json({ ok: false, copied, errorName: (error as Error).name, calls });
    }
  },
};
