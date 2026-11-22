// Operator-only Node utility. This module is never imported by the Worker.
import { createClient } from '@libsql/client';
import { pbkdf2, randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, unlink, open } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PasswordHasher,
  isPepperedPasswordHash,
  PASSWORD_PREFIX,
} from '../src/Security/PasswordHasher.ts';
import { readCredentials } from './test-live-auth.mjs';

export class MigrationError extends Error {}
export const isLegacyHash = (value) =>
  typeof value === 'string' && /^pbkdf2-sha256\$600000\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(value);
export const pepperFingerprint = (pepper) =>
  createHash('sha256')
    .update('karaoke-pepper-v1:' + pepper)
    .digest('hex')
    .slice(0, 12);
export async function verifyLegacyPassword(password, encoded) {
  if (!isLegacyHash(encoded)) return false;
  const [, , salt, expected] = encoded.split('$');
  const key = await new Promise((resolve, reject) =>
    pbkdf2(password, Buffer.from(salt, 'hex'), 600000, 32, 'sha256', (error, result) =>
      error ? reject(error) : resolve(result),
    ),
  );
  return timingSafeEqual(key, Buffer.from(expected, 'hex'));
}
function requirePepper(value) {
  if (
    typeof value !== 'string' ||
    value.length < 32 ||
    value.length > 512 ||
    value.trim() !== value
  )
    throw new MigrationError('Configure a dedicated PASSWORD_PEPPER of 32 to 512 characters.');
  return value;
}
export async function localSettings(path = '.dev.vars', allowLocal = false) {
  const values = parseEnv(await readFile(path, 'utf8'));
  let target;
  try {
    target = new URL(values.TURSO_DATABASE_URL);
  } catch {}
  const local = allowLocal && values.TURSO_DATABASE_URL?.startsWith('file:');
  if (
    !local &&
    (!target ||
      target.protocol !== 'libsql:' ||
      target.username ||
      target.password ||
      !values.TURSO_AUTH_TOKEN)
  )
    throw new MigrationError(
      'The selected .dev.vars must contain the remote libsql:// Turso URL and its token.',
    );
  return { values, host: local ? 'local SQLite' : target.hostname };
}

export async function preparePepper({
  envPath = '.dev.vars',
  dbFactory = createClient,
  allowLocal = false,
  log = console.log,
} = {}) {
  const lockPath = envPath + '.auth.lock';
  let lock;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST')
      throw new MigrationError(
        'Another pepper setup is running, or a previous setup left .dev.vars.auth.lock. Inspect it before retrying.',
      );
    throw error;
  }
  let temporary;
  try {
    const original = await readFile(envPath, 'utf8');
    const { values } = await localSettings(envPath, allowLocal);
    if (values.PASSWORD_PEPPER) {
      const pepper = requirePepper(values.PASSWORD_PEPPER);
      log('PASS: Existing Karaoke pepper retained; fingerprint ' + pepperFingerprint(pepper));
      return pepper;
    }
    const db = dbFactory({ url: values.TURSO_DATABASE_URL, authToken: values.TURSO_AUTH_TOKEN });
    let count;
    try {
      const result = await db.execute({
        sql: 'SELECT COUNT(*) AS count FROM users WHERE password_hash LIKE ?',
        args: [PASSWORD_PREFIX + '%'],
      });
      count = Number(result.rows[0]?.count);
      if (!Number.isSafeInteger(count) || count < 0)
        throw new MigrationError('Could not inspect existing password formats.');
    } finally {
      db.close();
    }
    if (count > 0)
      throw new MigrationError(
        'Peppered accounts already exist but the local pepper is missing. Restore the existing pepper; a new pepper was not generated.',
      );
    const pepper = randomBytes(32).toString('base64url');
    if ((await readFile(envPath, 'utf8')) !== original)
      throw new MigrationError(
        '.dev.vars changed during setup. Retry after finishing other edits.',
      );
    const eol = original.includes('\r\n') ? '\r\n' : '\n';
    const result =
      original + (original.endsWith('\n') ? '' : eol) + 'PASSWORD_PEPPER=' + pepper + eol;
    temporary = envPath + '.auth-' + randomUUID() + '.tmp';
    await writeFile(temporary, result, { flag: 'wx', mode: 0o600 });
    await rename(temporary, envPath);
    temporary = undefined;
    log('PASS: Dedicated Karaoke pepper saved locally; fingerprint ' + pepperFingerprint(pepper));
    return pepper;
  } finally {
    if (temporary) await unlink(temporary).catch(() => {});
    await lock.close();
    await unlink(lockPath);
  }
}

export async function migrateAccount({
  db,
  login,
  password,
  pepper,
  backupDirectory = '.local/auth-backups',
  apply = false,
  requireAdmin = false,
  log = console.log,
}) {
  requirePepper(pepper);
  if (
    typeof login !== 'string' ||
    !login.trim() ||
    typeof password !== 'string' ||
    !password ||
    password.length > 128
  )
    throw new MigrationError('Enter the existing username/email and current password.');
  const result = await db.execute({
    sql: 'SELECT id,role,is_active,password_hash FROM users WHERE username=? COLLATE NOCASE OR email=? COLLATE NOCASE',
    args: [login.trim(), login.trim()],
  });
  if (result.rows.length !== 1)
    throw new MigrationError('Account was not uniquely found. No account was changed.');
  const user = result.rows[0];
  if (Number(user.is_active) !== 1)
    throw new MigrationError('Account is inactive. No account was changed.');
  if (requireAdmin && user.role !== 'ADMIN')
    throw new MigrationError('Select the existing administrator for deployment verification.');
  const hasher = new PasswordHasher(pepper);
  if (isPepperedPasswordHash(user.password_hash)) {
    if (!(await hasher.verify(password, user.password_hash)))
      throw new MigrationError(
        'The current password or local pepper does not match the migrated account. No account was changed.',
      );
    log('PASS: Account already uses the configured pepper; no credential changes needed.');
    return { changed: false, alreadyMigrated: true };
  }
  if (!isLegacyHash(user.password_hash))
    throw new MigrationError('Unsupported stored hash. No account was changed.');
  if (!(await verifyLegacyPassword(password, user.password_hash)))
    throw new MigrationError('Current password did not match. No account was changed.');
  log('PASS: Current password verified locally against the legacy hash');
  const next = await hasher.hash(password);
  if (!(await hasher.verify(password, next)))
    throw new MigrationError('New verifier self-check failed. No account was changed.');
  if (!apply) {
    log('PASS: Migration dry run; new scheme verified, no database or backup writes');
    return { changed: false, alreadyMigrated: false };
  }
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const backupPath = resolve(backupDirectory, randomUUID() + '.json');
  await writeFile(
    backupPath,
    JSON.stringify(
      {
        formatVersion: 1,
        createdAt: new Date().toISOString(),
        userId: user.id,
        previousPasswordHash: user.password_hash,
        targetPepperFingerprint: pepperFingerprint(pepper),
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  log('Backup of the previous hash saved locally: ' + backupPath);
  const tx = await db.transaction('write');
  try {
    const updated = await tx.execute({
      sql: 'UPDATE users SET password_hash=? WHERE id=? AND password_hash=?',
      args: [next, user.id, user.password_hash],
    });
    if (updated.rowsAffected !== 1)
      throw new MigrationError(
        'Account changed during migration; transaction cancelled. Retry with the current password.',
      );
    await tx.execute({ sql: 'DELETE FROM sessions WHERE user_id=?', args: [user.id] });
    await tx.commit();
  } catch (error) {
    await tx.rollback().catch(() => {});
    throw error;
  } finally {
    tx.close();
  }
  const check = await db.execute({
    sql: 'SELECT password_hash FROM users WHERE id=?',
    args: [user.id],
  });
  if (check.rows[0]?.password_hash !== next)
    throw new MigrationError(
      'Migration was not confirmed. Keep the backup and inspect the selected database.',
    );
  log('PASS: Existing password migrated; account ID, role and other data preserved');
  log('PASS: Existing sessions for this account revoked');
  return { changed: true, alreadyMigrated: false, backupPath };
}

async function main() {
  const command = process.argv[2];
  if (command === 'check-target') {
    const { unstable_readConfig } = await import('wrangler');
    const config = unstable_readConfig({ config: 'wrangler.jsonc', env: 'production' });
    if (config.name !== 'karaoke-backend-production')
      throw new MigrationError(
        'The production configuration must target karaoke-backend-production.',
      );
    const expected = 'https://karaoke-backend-production.marclouiegi-olino.workers.dev';
    if (
      !String(config.vars?.FRONTEND_ORIGINS ?? '')
        .split(',')
        .map((value) => value.trim())
        .includes(expected)
    )
      throw new MigrationError(
        'Keep the production API origin allowed while running this deployment check.',
      );
    console.log('PASS: Existing Karaoke production target and origin verified');
    return;
  }
  if (command === 'prepare') {
    await preparePepper({ allowLocal: process.argv.includes('--allow-local') });
    return;
  }
  const { values, host } = await localSettings();
  const pepper = requirePepper(values.PASSWORD_PEPPER);
  if (command === 'payload') {
    // This mode is consumed by PowerShell and piped directly into Wrangler, never displayed.
    if (process.stdout.isTTY)
      throw new MigrationError(
        'Run the installer so the secret payload is captured and piped to Wrangler, rather than displayed.',
      );
    process.stdout.write(JSON.stringify({ PASSWORD_PEPPER: pepper }));
    return;
  }
  if (command !== 'migrate') throw new MigrationError('Use prepare, payload, or migrate.');
  const credentials = await readCredentials();
  console.log('Database target: ' + host);
  console.log(
    'Mode: ' +
      (process.argv.includes('--apply')
        ? 'apply verified password migration'
        : 'read-only dry run'),
  );
  const db = createClient({ url: values.TURSO_DATABASE_URL, authToken: values.TURSO_AUTH_TOKEN });
  try {
    await migrateAccount({
      db,
      ...credentials,
      pepper,
      apply: process.argv.includes('--apply'),
      requireAdmin: process.argv.includes('--require-admin'),
    });
    console.log('PASSWORD MIGRATION CHECK PASSED');
  } finally {
    credentials.password = '';
    db.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(
      'FAIL: ' +
        (error instanceof MigrationError
          ? error.message
          : 'Operation was not confirmed. Check connectivity and keep any generated backup. No raw error or credentials were printed.'),
    );
    process.exitCode = 1;
  });
}
