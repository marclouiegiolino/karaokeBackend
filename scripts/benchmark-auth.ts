import { PasswordHasher } from '../src/Security/PasswordHasher.js';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
const fileSettings = parseEnv(await readFile('.dev.vars', 'utf8').catch(() => ''));
const h = new PasswordHasher(fileSettings.PASSWORD_PEPPER ?? process.env.PASSWORD_PEPPER),
  start = performance.now(),
  hash = await h.hash('Benchmark-only password, never an account credential');
const middle = performance.now();
await h.verify('Benchmark-only password, never an account credential', hash);
console.log(
  JSON.stringify(
    {
      hashWallMs: Math.round(middle - start),
      verifyWallMs: Math.round(performance.now() - middle),
      note: 'Local wall time is NOT deployed Workers CPU time. This uses the approved 12,000-iteration HMAC-peppered scheme. Measure deployed auth CPU before launch.',
    },
    null,
    2,
  ),
);
