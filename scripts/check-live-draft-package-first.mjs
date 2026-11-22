import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BackendCheckError, practiceFiles } from './test-backend-e2e.mjs';
import { readCredentials } from './test-live-auth.mjs';
const origin = 'https://karaoke-backend-production.marclouiegi-olino.workers.dev';
const base = new URL(origin + '/api');
function requireCheck(ok, message) {
  if (!ok) throw new BackendCheckError(message);
}
export async function checkDraft({ login, password }, request = fetch, log = console.log) {
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
    if (path.endsWith('/uploads/complete')) {
      log(
        'COMPLETE HTTP ' +
          response.status +
          ' CF-Ray ' +
          (response.headers.get('cf-ray') ?? 'unavailable'),
      );
    }
    if (response.status !== status) {
      const code = /^[A-Z_]{1,64}$/.test(json?.error?.code ?? '')
        ? json.error.code
        : 'UNEXPECTED_RESPONSE';
      throw new BackendCheckError(`${method} ${path} failed: HTTP ${response.status}, ${code}.`);
    }
    return json;
  }
  function checkedMediaUrl(value) {
    const u = new URL(value);
    requireCheck(
      u.origin === 'https://9c440e422ba1fde78de0dd2e1c6a8514.r2.cloudflarestorage.com' &&
        u.pathname.startsWith('/karaoke-media/') &&
        !u.username &&
        !u.password,
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
      typeof songId === 'string' &&
        /^[0-9a-f-]{36}$/i.test(songId) &&
        created.data.status === 'DRAFT',
      'Song creation did not return a draft.',
    );
    log('Test song ID: ' + songId);
    pass('Create draft song in database');
    for (const [kind, bytes, contentType] of [
      ['package', files.package, 'application/json'],
      ['audio', files.audio, 'audio/wav'],
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
      log('Finalizing ' + kind);
      await api(`/songs/${songId}/uploads/complete`, {
        method: 'POST',
        body: { uploadId: intent.uploadId },
      });
      pass('Upload, verify and finalize ' + kind);
    }
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await checkDraft(await readCredentials());
    console.log('PASS: Production draft upload check');
  } catch (error) {
    console.error(
      error instanceof BackendCheckError
        ? error.message
        : 'FAIL: Input, network, or response error.',
    );
    process.exitCode = 1;
  }
}
