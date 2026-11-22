import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHmac, pbkdf2Sync, randomUUID } from 'node:crypto';
import { createClient } from '@libsql/client';
import { practiceFiles } from './test-backend-e2e.mjs';

// Capture the exact PID of the workerd child spawned by THIS Miniflare instance
// so unrelated workerd processes on the host never pollute local CPU estimates.
const require = createRequire(import.meta.url);
const cp = require('node:child_process');
const origSpawn = cp.spawn;
let ownedWorkerdPid = null;
cp.spawn = function patchedSpawn(command, args, options) {
  const child = origSpawn.call(this, command, args, options);
  if (String(command).toLowerCase().includes('workerd') && child.pid) {
    ownedWorkerdPid = child.pid;
  }
  return child;
};
syncBuiltinESMExports();

const { Miniflare, convertV4MiniflareOptions } = await import('miniflare');

const scriptPath = process.env.PROFILE_SCRIPT_PATH || 'dist/index.js';
const mapPath = `${scriptPath}.map`;
const origin = 'https://karaoke.example.com';
const pepper = 'fixture-only-karaoke-dedicated-pepper-32-characters';
const password = 'fixture-only-benchmark-password';
const files = practiceFiles();

const salt = Buffer.alloc(32, 11);
const derived = pbkdf2Sync(
  createHmac('sha256', pepper).update(password).digest(),
  salt,
  12000,
  32,
  'sha256',
);
const encodedHash = '$pbkdf2-sha256$12000$' + salt.toString('hex') + '$' + derived.toString('hex');

const db = createClient({ url: 'file::memory:' });
await db.executeMultiple(await readFile('src/Migrations/0001_initial.sql', 'utf8'));
const adminId = randomUUID();
await db.execute({
  sql: 'INSERT INTO users(id,username,email,display_name,password_hash,role,is_active,created_at) VALUES(?,?,?,?,?,?,1,?)',
  args: [
    adminId,
    'profileadmin',
    'profileadmin@example.com',
    'Profile Admin',
    encodedHash,
    'ADMIN',
    Date.now(),
  ],
});

// Optional source-map resolution for V8 hotspot reporting
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_VAL = new Int32Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) B64_VAL[B64.charCodeAt(i)] = i;
function createSourceMapResolver(bundleFile, sourceMapFile) {
  if (!existsSync(bundleFile) || !existsSync(sourceMapFile)) return null;
  const sm = JSON.parse(readFileSync(sourceMapFile, 'utf8'));
  const sources = sm.sources || [];
  const names = sm.names || [];
  const lines = [];
  const mappings = sm.mappings || '';
  let srcIdx = 0,
    srcLine = 0,
    srcCol = 0,
    nameIdx = 0,
    lineSegs = [],
    genCol = 0,
    i = 0;
  const vlq = () => {
    let res = 0,
      shift = 0;
    while (i < mappings.length) {
      const d = B64_VAL[mappings.charCodeAt(i++)];
      res += (d & 31) << shift;
      if ((d & 32) === 0) break;
      shift += 5;
    }
    return res & 1 ? -(res >> 1) : res >> 1;
  };
  while (i < mappings.length) {
    const ch = mappings.charCodeAt(i);
    if (ch === 59) {
      lines.push(lineSegs);
      lineSegs = [];
      genCol = 0;
      i++;
      continue;
    }
    if (ch === 44) {
      i++;
      continue;
    }
    genCol += vlq();
    let s = -1,
      sl = -1,
      sc = -1,
      nm = -1;
    if (i < mappings.length && mappings.charCodeAt(i) !== 44 && mappings.charCodeAt(i) !== 59) {
      srcIdx += vlq();
      srcLine += vlq();
      srcCol += vlq();
      s = srcIdx;
      sl = srcLine;
      sc = srcCol;
      if (i < mappings.length && mappings.charCodeAt(i) !== 44 && mappings.charCodeAt(i) !== 59) {
        nameIdx += vlq();
        nm = nameIdx;
      }
    }
    lineSegs.push([genCol, s, sl, sc, nm]);
  }
  lines.push(lineSegs);
  const distLines = readFileSync(bundleFile, 'utf8').split('\n');
  const commentMap = [];
  let curSrc = '(preamble)';
  for (const ln of distLines) {
    if (ln.startsWith('// node_modules/') || ln.startsWith('// src/')) curSrc = ln.slice(3);
    commentMap.push(curSrc);
  }
  return (cf) => {
    const fn = cf?.functionName || '(anon)';
    const l = cf?.lineNumber ?? -1;
    const c = cf?.columnNumber ?? 0;
    const url = cf?.url || '';
    if (l < 0 || !url) return { fn, file: '(builtin)', line: 0, pkg: '(builtin)' };
    if (!url.endsWith('.js')) return { fn, file: url, line: l + 1, pkg: url };
    const segs = lines[l];
    let best = -1;
    if (segs?.length) {
      let lo = 0,
        hi = segs.length - 1;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (segs[m][0] <= c) {
          best = m;
          lo = m + 1;
        } else hi = m - 1;
      }
    }
    const seg = best >= 0 && segs[best][1] >= 0 ? segs[best] : null;
    const file = seg ? (sources[seg[1]] || '').replace(/^(?:\.\.\/)+/, '') : commentMap[l] || url;
    let pkg = file;
    if (pkg.startsWith('node_modules/')) {
      const rest = pkg.slice('node_modules/'.length);
      pkg = rest.startsWith('@') ? rest.split('/').slice(0, 2).join('/') : rest.split('/')[0];
    }
    return {
      fn: seg && seg[4] >= 0 ? names[seg[4]] || fn : fn,
      file,
      line: seg ? seg[2] + 1 : l + 1,
      pkg,
    };
  };
}

const resolveFrame = createSourceMapResolver(scriptPath, mapPath);

const storedSqls = new Map();
const fromHranaArg = (a) =>
  a.type === 'null' ? null : a.type === 'integer' ? Number(a.value) : a.value;
const toHranaVal = (v) =>
  v === null || v === undefined
    ? { type: 'null' }
    : typeof v === 'number'
      ? Number.isInteger(v)
        ? { type: 'integer', value: String(v) }
        : { type: 'float', value: v }
      : typeof v === 'bigint'
        ? { type: 'integer', value: String(v) }
        : { type: 'text', value: String(v) };
const formatExecResult = (rs) => ({
  cols: rs.columns.map((name) => ({ name, decltype: null })),
  rows: rs.rows.map((row) => rs.columns.map((col) => toHranaVal(row[col]))),
  affected_row_count: rs.rowsAffected,
  last_insert_rowid: rs.lastInsertRowid != null ? String(rs.lastInsertRowid) : null,
});

function getOwnedWorkerdCpuMs(pid) {
  if (process.platform === 'win32') {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).TotalProcessorTime.TotalMilliseconds.ToString([System.Globalization.CultureInfo]::InvariantCulture)`,
      ],
      { encoding: 'utf8' },
    ).trim();
    const ms = Number(out);
    if (!Number.isFinite(ms)) {
      throw new Error(`Unexpected Windows CPU counter output for PID ${pid}: ${out}`);
    }
    return ms;
  }
  if (process.platform === 'linux') {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const utimeTicks = Number(fields[11]);
    const stimeTicks = Number(fields[12]);
    return ((utimeTicks + stimeTicks) / 100) * 1000;
  }
  return null;
}

function createCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  };
  return new Promise((resolve, reject) => {
    ws.onopen = () =>
      resolve({
        send(method, params = {}) {
          const id = ++seq;
          ws.send(JSON.stringify({ id, method, params }));
          return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
        },
        close() {
          ws.close();
        },
      });
    ws.onerror = reject;
  });
}

let simulatedDelayMs = 0;
let outboundWaitMs = 0;
let outboundCallsDuringStartup = 0;
let startupCompleted = false;

const startupWallT0 = performance.now();
const mf = new Miniflare({
  ...convertV4MiniflareOptions({
    workers: [
      {
        name: 'profile-worker',
        modules: true,
        scriptPath,
        compatibilityDate: '2026-11-17',
        compatibilityFlags: ['nodejs_compat'],
        r2Buckets: { MEDIA_BUCKET: 'karaoke-media-profile' },
        outboundService: async (req) => {
          if (!startupCompleted) {
            outboundCallsDuringStartup++;
          }
          const t0 = performance.now();
          try {
            const u = new URL(req.url);
            if (u.hostname.endsWith('.r2.cloudflarestorage.com')) {
              if (req.method === 'PUT' && req.headers.has('x-amz-copy-source')) {
                if (simulatedDelayMs > 0) {
                  await new Promise((r) => setTimeout(r, simulatedDelayMs));
                }
                return new Response(
                  '<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><ETag>"promoted-etag"</ETag><LastModified>2026-11-21T00:00:00.000Z</LastModified></CopyObjectResult>',
                  { status: 200, headers: { 'content-type': 'application/xml' } },
                );
              }
              throw new Error(`Unexpected outbound R2 request in profile-worker: ${req.method}`);
            }

            const body = await req.json();
            const results = [];
            let closed = false;
            for (const item of body.requests) {
              if (item.type === 'store_sql') {
                storedSqls.set(item.sql_id, item.sql);
                results.push({ type: 'ok', response: { type: 'store_sql' } });
              } else if (item.type === 'close_sql') {
                storedSqls.delete(item.sql_id);
                results.push({ type: 'ok', response: { type: 'close_sql' } });
              } else if (item.type === 'execute') {
                const sql = item.stmt.sql ?? storedSqls.get(item.stmt.sql_id);
                if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) {
                  results.push({
                    type: 'ok',
                    response: {
                      type: 'execute',
                      result: {
                        cols: [],
                        rows: [],
                        affected_row_count: 0,
                        last_insert_rowid: null,
                      },
                    },
                  });
                } else {
                  const args = (item.stmt.args ?? []).map(fromHranaArg);
                  const rs = await db.execute({ sql, args });
                  results.push({
                    type: 'ok',
                    response: { type: 'execute', result: formatExecResult(rs) },
                  });
                }
              } else if (item.type === 'batch') {
                const step_results = [];
                const step_errors = [];
                for (const step of item.batch.steps) {
                  if (step.condition?.type === 'not') {
                    step_results.push(null);
                    step_errors.push(null);
                    continue;
                  }
                  const sql = step.stmt.sql ?? storedSqls.get(step.stmt.sql_id);
                  if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) {
                    step_results.push({
                      cols: [],
                      rows: [],
                      affected_row_count: 0,
                      last_insert_rowid: null,
                    });
                  } else {
                    const args = (step.stmt.args ?? []).map(fromHranaArg);
                    const rs = await db.execute({ sql, args });
                    step_results.push(formatExecResult(rs));
                  }
                  step_errors.push(null);
                }
                results.push({
                  type: 'ok',
                  response: { type: 'batch', result: { step_results, step_errors } },
                });
              } else if (item.type === 'close') {
                closed = true;
                results.push({ type: 'ok', response: { type: 'close' } });
              } else {
                throw new Error(`Unsupported Hrana request type in profile-worker: ${item.type}`);
              }
            }
            if (simulatedDelayMs > 0) {
              await new Promise((r) => setTimeout(r, simulatedDelayMs));
            }
            return Response.json({ baton: closed ? null : 'profile-baton', results });
          } finally {
            outboundWaitMs += performance.now() - t0;
          }
        },
        bindings: {
          APP_ENV: 'production',
          FRONTEND_ORIGINS: origin,
          TURSO_DATABASE_URL: 'libsql://test-not-contacted.turso.io',
          TURSO_AUTH_TOKEN: 'test-not-a-real-token',
          PASSWORD_PEPPER: pepper,
          R2_ACCOUNT_ID: '00000000000000000000000000000000',
          R2_BUCKET: 'karaoke-media',
          R2_ACCESS_KEY_ID: 'test-not-a-real-key',
          R2_SECRET_ACCESS_KEY: 'test-not-a-real-secret',
          REGISTRATION_ENABLED: 'false',
        },
        ratelimits: {
          API_LIMITER: { namespace_id: '2001', simple: { limit: 120000, period: 60 } },
          AUTH_LIMITER: { namespace_id: '2002', simple: { limit: 120000, period: 60 } },
        },
      },
    ],
  }),
  inspectorPort: 0,
});

try {
  await mf.ready;
  const startupHostWallMs = +(performance.now() - startupWallT0).toFixed(2);
  startupCompleted = true;
  cp.spawn = origSpawn;
  syncBuiltinESMExports();
  if (!ownedWorkerdPid) {
    throw new Error('Failed to capture the PID of the workerd process owned by this profiling run');
  }
  assert.equal(
    outboundCallsDuringStartup,
    0,
    'Startup prewarming must not perform any outbound network I/O',
  );
  const startupWorkerdCpuMs = getOwnedWorkerdCpuMs(ownedWorkerdPid);

  const r2 = await mf.getR2Bucket('MEDIA_BUCKET');
  const inspectorUrl = await mf.getInspectorURL();
  const cdp = await createCdp(`ws://127.0.0.1:${inspectorUrl.port}/core:user:profile-worker`);
  await cdp.send('Profiler.enable');

  // Authenticate an admin session for upload route benchmarks (never log the cookie or token).
  const validLoginRes = await mf.dispatchFetch(origin + '/api/auth/login', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'profileadmin', password }),
  });
  assert.equal(validLoginRes.status, 200);
  const validLoginJson = await validLoginRes.json();
  assert.equal(validLoginJson.user?.username, 'profileadmin');
  const validCookie = validLoginRes.headers.get('set-cookie')?.split(';')[0];
  assert.match(validCookie ?? '', /^__Host-karaoke_session=[A-Za-z0-9_-]{43}$/);

  const UPLOAD_ITERS = 60;
  const WARMUP_ITERS = 5;
  const delays = [0, 20];
  const totalFixturesPerScenario = UPLOAD_ITERS * delays.length * 2 + WARMUP_ITERS;

  const reservationSongs = [];
  const audioCompletionFixtures = [];
  const packageCompletionFixtures = [];
  const now = Date.now();

  for (let i = 0; i < totalFixturesPerScenario; i++) {
    const resSongId = randomUUID();
    reservationSongs.push(resSongId);
    await db.execute({
      sql: "INSERT INTO songs(id,title,artist,duration_ms,status,package_version,created_by,created_at,updated_at) VALUES(?,?,?,?,'DRAFT',1,?,?,?)",
      args: [resSongId, `Res Song ${i}`, 'Artist', files.durationMs, adminId, now, now],
    });

    const audSongId = randomUUID();
    const audUploadId = randomUUID();
    const audStagingKey = `_staging/${audUploadId}`;
    audioCompletionFixtures.push({ songId: audSongId, uploadId: audUploadId });
    await db.execute({
      sql: "INSERT INTO songs(id,title,artist,duration_ms,status,package_version,created_by,created_at,updated_at) VALUES(?,?,?,?,'DRAFT',1,?,?,?)",
      args: [audSongId, `Aud Song ${i}`, 'Artist', files.durationMs, adminId, now, now],
    });
    await db.execute({
      sql: "INSERT INTO uploads(id,song_id,kind,staging_key,final_key,content_type,byte_size,status,expires_at,created_at) VALUES(?,?,'audio',?,?,?,?,'PENDING',?,?)",
      args: [
        audUploadId,
        audSongId,
        audStagingKey,
        `songs/${audSongId}/v1/audio-${audUploadId}`,
        'audio/wav',
        files.audio.length,
        now + 900000,
        now,
      ],
    });
    await r2.put(audStagingKey, files.audio, { httpMetadata: { contentType: 'audio/wav' } });

    const pkgSongId = randomUUID();
    const pkgUploadId = randomUUID();
    const pkgStagingKey = `_staging/${pkgUploadId}`;
    packageCompletionFixtures.push({ songId: pkgSongId, uploadId: pkgUploadId });
    await db.execute({
      sql: "INSERT INTO songs(id,title,artist,duration_ms,status,package_version,created_by,created_at,updated_at) VALUES(?,?,?,?,'DRAFT',1,?,?,?)",
      args: [pkgSongId, `Pkg Song ${i}`, 'Artist', files.durationMs, adminId, now, now],
    });
    await db.execute({
      sql: "INSERT INTO uploads(id,song_id,kind,staging_key,final_key,content_type,byte_size,status,expires_at,created_at) VALUES(?,?,'package',?,?,?,?,'PENDING',?,?)",
      args: [
        pkgUploadId,
        pkgSongId,
        pkgStagingKey,
        `songs/${pkgSongId}/v1/package-${pkgUploadId}`,
        'application/json',
        files.package.length,
        now + 900000,
        now,
      ],
    });
    await r2.put(pkgStagingKey, files.package, {
      httpMetadata: { contentType: 'application/json' },
    });
  }

  await db.execute({
    sql: 'UPDATE storage_budget SET reserved_bytes = ? WHERE id = 1',
    args: [totalFixturesPerScenario * (files.audio.length + files.package.length)],
  });

  let resCursor = 0;
  let audCursor = 0;
  let pkgCursor = 0;

  const scenarios = [
    {
      scenario: 'POST /api/songs/:id/uploads (reservation)',
      iterations: UPLOAD_ITERS,
      run: () => {
        const songId = reservationSongs[resCursor++];
        return mf.dispatchFetch(`${origin}/api/songs/${songId}/uploads`, {
          method: 'POST',
          headers: { Origin: origin, Cookie: validCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kind: 'package',
            contentType: 'application/json',
            byteSize: files.package.length,
          }),
        });
      },
      verify: async (res) => {
        assert.equal(res.status, 201);
        const body = await res.json();
        assert.match(body.uploadId ?? '', /^[0-9a-f-]{36}$/i);
        assert.equal(body.method, 'PUT');
        assert.equal(body.expiresIn, 300);
        assert.equal(typeof body.url, 'string');
      },
    },
    {
      scenario: 'POST /api/songs/:id/uploads/complete (audio)',
      iterations: UPLOAD_ITERS,
      run: () => {
        const item = audioCompletionFixtures[audCursor++];
        return mf.dispatchFetch(`${origin}/api/songs/${item.songId}/uploads/complete`, {
          method: 'POST',
          headers: { Origin: origin, Cookie: validCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ uploadId: item.uploadId }),
        });
      },
      verify: async (res) => {
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.data?.hasAudio, true);
        assert.equal(body.data?.status, 'DRAFT');
      },
    },
    {
      scenario: 'POST /api/songs/:id/uploads/complete (package)',
      iterations: UPLOAD_ITERS,
      run: () => {
        const item = packageCompletionFixtures[pkgCursor++];
        return mf.dispatchFetch(`${origin}/api/songs/${item.songId}/uploads/complete`, {
          method: 'POST',
          headers: { Origin: origin, Cookie: validCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ uploadId: item.uploadId }),
        });
      },
      verify: async (res) => {
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.data?.scoringAvailable, true);
        assert.equal(body.data?.status, 'DRAFT');
      },
    },
  ];

  // Warm all upload routes before collecting measurements.
  for (let i = 0; i < WARMUP_ITERS; i++) {
    for (const s of scenarios) {
      const res = await s.run();
      await s.verify(res);
    }
  }

  const rows = [];
  // Pass 1: measure local wall, stubbed outbound I/O wait, and owned-PID OS CPU WITHOUT CDP profiler overhead.
  await cdp.send('Profiler.disable');
  for (const delay of delays) {
    simulatedDelayMs = delay;
    for (const s of scenarios) {
      outboundWaitMs = 0;
      const cpuBefore = getOwnedWorkerdCpuMs(ownedWorkerdPid);
      const t0 = performance.now();
      for (let i = 0; i < s.iterations; i++) {
        const res = await s.run();
        await s.verify(res);
      }
      const wallMs = performance.now() - t0;
      const cpuAfter = getOwnedWorkerdCpuMs(ownedWorkerdPid);
      rows.push({
        simIoDelayMs: delay,
        scenario: s.scenario,
        verifiedResponses: `${s.iterations}/${s.iterations}`,
        estLocalWallMs: +(wallMs / s.iterations).toFixed(2),
        estLocalIoWaitMs: +(outboundWaitMs / s.iterations).toFixed(2),
        estLocalV8SampleMs: 0,
        v8ActiveSamples: 0,
        estLocalWorkerdPidCpuMs:
          cpuBefore !== null && cpuAfter !== null
            ? +((cpuAfter - cpuBefore) / s.iterations).toFixed(2)
            : null,
      });
    }
  }

  // Pass 2: measure V8 CDP active sample ticks at 50 us interval cleanly in a separate pass.
  const SAMPLE_INTERVAL_US = 50;
  const SAMPLE_MS = SAMPLE_INTERVAL_US / 1000;
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: SAMPLE_INTERVAL_US });
  let rowIndex = 0;
  const hotspotSummaries = [];
  for (const delay of delays) {
    simulatedDelayMs = delay;
    for (const s of scenarios) {
      await cdp.send('Profiler.start');
      for (let i = 0; i < s.iterations; i++) {
        const res = await s.run();
        await s.verify(res);
      }
      const { profile } = await cdp.send('Profiler.stop');
      let activeHits = 0;
      const byPkg = new Map();
      const byFn = new Map();
      for (const n of profile.nodes) {
        const h = n.hitCount ?? 0;
        if (!h) continue;
        const fn = n.callFrame?.functionName || '';
        if (fn !== '(idle)' && fn !== '(program)' && fn !== '(root)') {
          activeHits += h;
          if (delay === 0 && resolveFrame) {
            const r = resolveFrame(n.callFrame);
            byPkg.set(r.pkg, (byPkg.get(r.pkg) ?? 0) + h);
            const key = `${r.fn}@${r.file}:${r.line}`;
            byFn.set(key, (byFn.get(key) ?? 0) + h);
          }
        }
      }
      const row = rows[rowIndex++];
      row.v8ActiveSamples = activeHits;
      row.estLocalV8SampleMs = +((activeHits * SAMPLE_MS) / s.iterations).toFixed(3);
      if (delay === 0 && resolveFrame) {
        hotspotSummaries.push({
          scenario: s.scenario,
          activeHits,
          topPackages: Object.fromEntries(
            [...byPkg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
          ),
          topFunctions: [...byFn.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([fn, hits]) => ({ hits, fn })),
        });
      }
    }
  }
  await cdp.send('Profiler.disable');

  console.log(
    `\nLOCAL STARTUP PROFILE (owned workerd PID ${ownedWorkerdPid}, bundle ${scriptPath}):`,
  );
  console.table([
    {
      bundle: scriptPath,
      outboundCallsDuringStartup,
      estStartupHostWallMs: startupHostWallMs,
      estStartupWorkerdPidCpuMs:
        startupWorkerdCpuMs !== null ? +startupWorkerdCpuMs.toFixed(2) : null,
    },
  ]);

  console.log(
    `LOCAL UPLOAD ESTIMATES ONLY — owned workerd PID ${ownedWorkerdPid} (${UPLOAD_ITERS} warmed iterations/scenario):`,
  );
  console.table(rows);

  if (hotspotSummaries.length > 0) {
    console.log('\nSOURCE-MAPPED V8 HOTSPOTS (simIoDelayMs = 0, 50 us sampling interval):');
    for (const h of hotspotSummaries) {
      console.log(`\n--- ${h.scenario} (total V8 samples: ${h.activeHits}) ---`);
      console.log('Top packages:', h.topPackages);
      for (const f of h.topFunctions) {
        console.log(`  ${String(f.hits).padStart(4)} hits: ${f.fn}`);
      }
    }
  }

  console.log(
    '\nDisclaimer: All timings above (local wall time, stubbed I/O wait, V8 CDP sample ticks, and per-PID OS CPU counter deltas) are LOCAL ESTIMATES ONLY and do NOT prove deployed Cloudflare Workers Free (<10 ms CPU) suitability.',
  );
  cdp.close();
} finally {
  cp.spawn = origSpawn;
  syncBuiltinESMExports();
  await mf.dispose();
  db.close();
}
