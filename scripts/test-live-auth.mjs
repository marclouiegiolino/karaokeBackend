import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const productionOrigin = 'https://karaoke-backend-production.marclouiegi-olino.workers.dev';
export class LiveAuthError extends Error {}
const knownCodes = new Set([
  'AUTH_UNAVAILABLE',
  'VALIDATION_ERROR',
  'INVALID_JSON',
  'INVALID_CREDENTIALS',
  'ORIGIN_DENIED',
  'ORIGIN_REQUIRED',
  'UNAUTHENTICATED',
  'RATE_LIMITED',
  'BODY_TOO_LARGE',
  'INTERNAL_ERROR',
]);
function check(ok, message) {
  if (!ok) throw new LiveAuthError(message);
}
function networkCode(error) {
  const allowed = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'ABORT_ERR',
    'TypeError',
    'AbortError',
    'TimeoutError',
  ]);
  return (
    [error?.cause?.code, error?.code, error?.name].find((value) => allowed.has(value)) ??
    'NETWORK_ERROR'
  );
}
export async function readCredentials(input = process.stdin) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  try {
    for await (const part of input) {
      text += typeof part === 'string' ? part : decoder.decode(part, { stream: true });
      check(Buffer.byteLength(text) <= 8192, 'Credential input exceeds the limit.');
    }
    text += decoder.decode();
    const value = JSON.parse(text.replace(/^\uFEFF/, ''));
    check(
      typeof value?.login === 'string' &&
        value.login.trim().length >= 1 &&
        value.login.trim().length <= 254,
      'Enter a username or email.',
    );
    check(
      typeof value?.password === 'string' &&
        value.password.length >= 1 &&
        value.password.length <= 128,
      'Enter a password of 1 to 128 characters.',
    );
    return { login: value.login.trim(), password: value.password };
  } catch (error) {
    if (error instanceof LiveAuthError) throw error;
    throw new LiveAuthError('Could not read credentials. Run test-live-auth.ps1.');
  }
}

async function responseText(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '',
    size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      check(size <= 65536, 'Response exceeds the diagnostic size limit.');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function runLiveAuth({
  login,
  password,
  origin = productionOrigin,
  request = fetch,
  log = console.log,
}) {
  check(
    origin === productionOrigin,
    'Credentials may only be sent to your exact production HTTPS origin.',
  );
  check(
    typeof login === 'string' && login.trim().length >= 1 && login.trim().length <= 254,
    'Enter a username or email.',
  );
  check(
    typeof password === 'string' && password.length >= 1 && password.length <= 128,
    'Enter a password of 1 to 128 characters.',
  );
  login = login.trim();
  let cookie = '',
    cookieAttributes = '',
    problem;
  async function api(operation, path, { method = 'GET', body, status = 200 } = {}) {
    const headers = {
      Origin: origin,
      Accept: 'application/json',
      'User-Agent': 'KaraokeDeploymentCheck/1.0',
    };
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
    let response;
    try {
      response = await request(origin + '/api' + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      });
    } catch (error) {
      throw new LiveAuthError(operation + ' connection failed: ' + networkCode(error));
    }
    // Capture only this application's session; never print Set-Cookie or forward other cookies.
    if (path === '/auth/login') {
      const line = (response.headers.getSetCookie?.() ?? []).find((value) =>
        /^__Host-karaoke_session=[A-Za-z0-9_-]{43}(?:;|$)/.test(value),
      );
      if (line) {
        cookie = line.split(';')[0];
        cookieAttributes = line;
      }
    }
    let text;
    try {
      text = await responseText(response);
    } catch (error) {
      if (error instanceof LiveAuthError) throw error;
      throw new LiveAuthError(operation + ' response read failed: ' + networkCode(error));
    }
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const contentType = response.headers.get('content-type') ?? '';
    const responseType = !text
      ? 'empty'
      : json !== null
        ? 'json'
        : /html/i.test(contentType) || /^\s*<!doctype html|^\s*<html/i.test(text)
          ? 'html'
          : 'text';
    const details = { operation, httpStatus: response.status, responseType };
    const requestId = response.headers.get('x-request-id') ?? json?.requestId;
    if (/^[0-9a-f-]{36}$/i.test(requestId ?? '')) details.requestId = requestId;
    const ray = response.headers.get('cf-ray');
    if (/^[0-9a-f]{16,32}(?:-[A-Z]{3})?$/i.test(ray ?? '')) details.cfRay = ray;
    const code = knownCodes.has(json?.error?.code)
      ? json.error.code
      : response.status === status
        ? undefined
        : 'UNCLASSIFIED_RESPONSE';
    if (code) details.errorCode = code;
    if (response.status >= 400 && json === null) {
      const match = /\b(1101|1102|1010|1020)\b/.exec(text);
      if (match) details.possiblePlatformCode = match[1];
    }
    if (json?.error?.code === 'VALIDATION_ERROR' && Array.isArray(json.error.issues)) {
      details.validationFields = [
        ...new Set(
          json.error.issues.flatMap((issue) =>
            Array.isArray(issue.path)
              ? issue.path.filter((field) => field === 'login' || field === 'password')
              : [],
          ),
        ),
      ];
    }
    log('INFO: ' + JSON.stringify(details));
    check(
      response.status === status,
      operation + ': HTTP ' + response.status + ', ' + code + ' (' + responseType + ').',
    );
    return json;
  }
  try {
    const health = await api('Health', '/health');
    check(health?.status === 'ok', 'Health response was unexpected.');
    log('PASS: Live health');
    const result = await api('Login', '/auth/login', { method: 'POST', body: { login, password } });
    password = '';
    check(cookie, 'Login returned no recognized production session cookie.');
    check(
      /;\s*Secure(?:;|$)/i.test(cookieAttributes) &&
        /;\s*HttpOnly(?:;|$)/i.test(cookieAttributes) &&
        /;\s*Path=\/(?:;|$)/i.test(cookieAttributes) &&
        /;\s*SameSite=None(?:;|$)/i.test(cookieAttributes) &&
        !/;\s*Domain=/i.test(cookieAttributes),
      'Production session cookie attributes were unexpected.',
    );
    check(
      result?.user?.role === 'ADMIN' && typeof result?.user?.id === 'string',
      'The signed-in account must be an administrator.',
    );
    log('PASS: Live administrator login');
    const me = await api('Session lookup', '/auth/me');
    check(
      me?.user?.id === result.user.id && me?.user?.role === 'ADMIN',
      'Session account did not match login.',
    );
    log('PASS: Live administrator session');
  } catch (error) {
    problem = error;
  } finally {
    password = '';
    if (cookie) {
      try {
        await api('Logout', '/auth/logout', { method: 'POST', status: 204 });
        // Keep the old cookie for this one check: it must no longer authorize requests.
        await api('Revoked session', '/auth/me', { status: 401 });
        log('PASS: Live logout and session revocation');
      } catch (error) {
        if (!problem) problem = error;
        else log('FAIL: Session cleanup could not be verified.');
      }
    }
    cookie = '';
    cookieAttributes = '';
  }
  if (problem) throw problem;
  log('LIVE AUTH CHECK PASSED');
  log(
    'This checks authentication only; deployed CPU time and browser behavior require separate verification.',
  );
}

async function main() {
  console.log('Live auth check v1; target: ' + productionOrigin);
  const credentials = await readCredentials();
  try {
    await runLiveAuth(credentials);
  } finally {
    credentials.password = '';
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(
      'FAIL: ' + (error instanceof LiveAuthError ? error.message : 'Unexpected client failure.'),
    );
    console.error(
      'Share PASS/FAIL and INFO lines only. No passwords, cookies, or response bodies.',
    );
    process.exitCode = 1;
  });
}
