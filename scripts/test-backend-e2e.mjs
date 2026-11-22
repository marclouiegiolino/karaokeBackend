import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';

export class BackendCheckError extends Error {}
const requireCheck = (ok, message) => {
  if (!ok) throw new BackendCheckError(message);
};
const equalBytes = (a, b) => a.length === b.length && a.every((n, i) => n === b[i]);

export function practiceFiles() {
  const sampleRate = 22050,
    durationMs = 4000,
    samples = sampleRate * 4;
  const notes = [
    { startMs: 0, endMs: 1000, midiNote: 60 },
    { startMs: 1200, endMs: 2200, midiNote: 62 },
    { startMs: 2400, endMs: 3800, midiNote: 64 },
  ];
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const ms = (i / sampleRate) * 1000,
      note = notes.find((n) => ms >= n.startMs && ms < n.endMs);
    if (!note) continue;
    const elapsed = (ms - note.startMs) / 1000,
      remaining = (note.endMs - ms) / 1000;
    const envelope = Math.min(1, elapsed / 0.02, remaining / 0.03);
    const frequency = 440 * 2 ** ((note.midiNote - 69) / 12);
    wav.writeInt16LE(
      Math.round(Math.sin(2 * Math.PI * frequency * elapsed) * envelope * 0.2 * 32767),
      44 + i * 2,
    );
  }
  const melody = {
    formatVersion: 1,
    packageVersion: 1,
    durationMs,
    lyrics: [{ startMs: 0, endMs: 4000, text: 'Practice: sing C, D, E' }],
    notes,
  };
  return {
    audio: wav,
    package: new TextEncoder().encode(JSON.stringify(melody)),
    melody,
    durationMs,
  };
}

export async function runBackendCheck({
  baseUrl = 'http://localhost:8787/api',
  origin = 'http://localhost:3000',
  login,
  password,
  request = fetch,
  log = console.log,
}) {
  const base = new URL(baseUrl);
  requireCheck(
    ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname),
    'This helper sends credentials only to a local backend.',
  );
  requireCheck(
    ['http:', 'https:'].includes(base.protocol) &&
      base.pathname === '/api' &&
      !base.search &&
      !base.hash &&
      !base.username &&
      !base.password,
    'Use a local API URL ending in /api, without a trailing slash.',
  );
  requireCheck(
    new URL(origin).origin === origin,
    'Frontend origin must be exact, without a trailing slash.',
  );
  requireCheck(login && password, 'Enter an administrator username/email and password.');
  let cookie = '',
    songId,
    passed = 0,
    problem;
  const title = '[TEST] C-D-E practice ' + randomUUID().slice(0, 8);
  const files = practiceFiles();
  const pass = (label) => {
    passed++;
    log('PASS: ' + label);
  };
  async function api(path, { method = 'GET', body, status = 200 } = {}) {
    const headers = { Origin: origin };
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await request(base.href + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(60000),
    });
    const setCookies = response.headers.getSetCookie?.() ?? [];
    for (const line of setCookies) {
      const pair = line.split(';')[0];
      if (pair.startsWith('karaoke_session=') || pair.startsWith('__Host-karaoke_session='))
        cookie = pair;
    }
    const json = response.status === 204 ? null : await response.json().catch(() => null);
    if (response.status !== status) {
      const code = typeof json?.error?.code === 'string' ? json.error.code : 'UNEXPECTED_RESPONSE';
      throw new BackendCheckError(`${method} ${path} failed: HTTP ${response.status}, ${code}.`);
    }
    return json;
  }
  function checkedMediaUrl(value) {
    const u = new URL(value);
    requireCheck(
      u.protocol === 'https:' && u.hostname.endsWith('.r2.cloudflarestorage.com'),
      'Backend returned an unexpected media host.',
    );
    return u.href;
  }
  async function media(url, options = {}) {
    // Cookie and administrator password are NEVER forwarded to media endpoints.
    return request(checkedMediaUrl(url), {
      ...options,
      headers: { Origin: origin, ...options.headers },
      redirect: 'error',
      signal: AbortSignal.timeout(60000),
    });
  }
  log('Test song: ' + title);
  try {
    requireCheck((await api('/health')).status === 'ok', 'Backend health response is unexpected.');
    pass('Backend health');
    const signedIn = await api('/auth/login', { method: 'POST', body: { login, password } });
    requireCheck(
      signedIn?.user?.role === 'ADMIN',
      'The signed-in account must be an administrator.',
    );
    requireCheck(cookie, 'Login did not set a session cookie.');
    const profile = await api('/auth/me');
    requireCheck(
      profile?.user?.id === signedIn.user.id,
      'Session lookup did not match the signed-in user.',
    );
    pass('Administrator login and session lookup');
    const created = await api('/songs', {
      method: 'POST',
      body: {
        title,
        artist: 'Generated practice tones',
        genre: 'Test',
        language: 'Instrumental',
        durationMs: files.durationMs,
      },
      status: 201,
    });
    songId = created?.data?.id;
    requireCheck(
      typeof songId === 'string' && created.data.status === 'DRAFT',
      'Song creation did not return a draft.',
    );
    log('Test song ID: ' + songId);
    pass('Create draft song in database');
    for (const [kind, bytes, contentType] of [
      ['audio', files.audio, 'audio/wav'],
      ['package', files.package, 'application/json'],
    ]) {
      const intent = await api(`/songs/${songId}/uploads`, {
        method: 'POST',
        body: { kind, contentType, byteSize: bytes.length },
        status: 201,
      });
      requireCheck(
        intent.method === 'PUT' && typeof intent.uploadId === 'string',
        'Upload intent is invalid.',
      );
      const uploaded = await media(intent.url, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: bytes,
      });
      requireCheck(uploaded.ok, `${kind} upload to R2 failed: HTTP ${uploaded.status}.`);
      await api(`/songs/${songId}/uploads/complete`, {
        method: 'POST',
        body: { uploadId: intent.uploadId },
      });
      pass('Upload, verify and finalize ' + kind);
    }
    const published = await api(`/songs/${songId}/publish`, { method: 'POST' });
    requireCheck(published?.data?.status === 'PUBLISHED', 'Song was not published.');
    const list = await api('/songs?search=' + encodeURIComponent(title));
    requireCheck(
      list?.data?.some((s) => s.id === songId),
      'Published song is missing from the catalog.',
    );
    pass('Publish and find song in catalog');
    const manifest = await api(`/songs/${songId}/download`);
    requireCheck(
      manifest.songId === songId && manifest.packageVersion === 1,
      'Download manifest differs from the published song.',
    );
    const audio = await media(manifest.audioUrl);
    requireCheck(audio.ok, 'Published audio download failed.');
    requireCheck(
      equalBytes(new Uint8Array(await audio.arrayBuffer()), files.audio),
      'Published audio bytes differ from the generated WAV.',
    );
    const pkg = await media(manifest.packageUrl);
    requireCheck(pkg.ok, 'Published melody package download failed.');
    requireCheck(
      equalBytes(new Uint8Array(await pkg.arrayBuffer()), files.package),
      'Published package bytes differ from the generated melody package.',
    );
    pass('Published audio and melody downloads match original bytes');
    const partial = await media(manifest.audioUrl, { headers: { Range: 'bytes=0-43' } });
    requireCheck(partial.status === 206, 'Published audio does not support byte-range playback.');
    requireCheck(
      equalBytes(new Uint8Array(await partial.arrayBuffer()), files.audio.slice(0, 44)),
      'Published audio range differs from the WAV header.',
    );
    pass('Published audio byte-range access');
  } catch (error) {
    problem = error;
  } finally {
    if (cookie) {
      try {
        await api('/auth/logout', { method: 'POST', status: 204 });
        pass('Logout test session');
      } catch (error) {
        problem ??= error;
      }
      cookie = '';
    }
  }
  if (problem) {
    if (songId) log('The test song remains available for inspection: ' + songId);
    throw problem;
  }
  return { songId, title, passed, audio: files.audio, package: files.package };
}

async function readSecret() {
  requireCheck(process.stdin.isTTY, 'Run this helper in an interactive PowerShell terminal.');
  process.stdout.write('Administrator password (hidden): ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const clean = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    };
    const onData = (chunk) => {
      if (chunk.startsWith('\u001b')) return;
      for (const c of chunk) {
        if (c === '\u0003') {
          clean();
          reject(new BackendCheckError('Cancelled.'));
          return;
        }
        if (c === '\r' || c === '\n') {
          clean();
          resolve(value);
          return;
        }
        if (c === '\u007f' || c === '\b') value = Array.from(value).slice(0, -1).join('');
        else if (c >= ' ') value += c;
      }
    };
    process.stdin.on('data', onData);
  });
}
async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const login = (await rl.question('Administrator username/email: ')).trim();
  rl.close();
  let password = await readSecret();
  const result = await runBackendCheck({
    login,
    password,
    baseUrl: process.env.KARAOKE_TEST_BASE_URL ?? 'http://localhost:8787/api',
    origin: process.env.FRONTEND_ORIGINS?.split(',')[0]?.trim() ?? 'http://localhost:3000',
  });
  password = '';
  await mkdir('.local/e2e', { recursive: true });
  const path = resolve('.local/e2e', result.songId + '.wav');
  await writeFile(path, result.audio);
  await writeFile(resolve('.local/e2e', result.songId + '.json'), result.package);
  console.log('BACKEND END-TO-END TEST PASSED');
  console.log('Practice audio saved locally:', path);
  console.log(
    'The published [TEST] practice song is retained for your future frontend/scoring tests.',
  );
  console.log('No microphone scoring or simulated performance result was created.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(
      error instanceof BackendCheckError
        ? 'FAIL: ' + error.message
        : 'FAIL: Request or file operation failed (' +
            String(error.code ?? error.name ?? 'unknown') +
            ').',
    );
    console.error('Share PASS/FAIL output, not passwords, cookies, .dev.vars, or signed URLs.');
    process.exitCode = 1;
  });
}
