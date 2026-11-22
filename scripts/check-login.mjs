import { createClient } from '@libsql/client';
import { PasswordHasher, isPepperedPasswordHash } from '../src/Security/PasswordHasher.ts';
import { isLegacyHash, verifyLegacyPassword } from './worker-auth-migration.mjs';
import {
  LiveAuthError as BackendCheckError,
  readCredentials as readStdinCredentials,
} from './test-live-auth.mjs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function checkLogin({
  db,
  login,
  password,
  pepper = process.env.PASSWORD_PEPPER,
  log = console.log,
}) {
  const result = await db.execute({
    sql: 'SELECT role,is_active,password_hash FROM users WHERE username=? COLLATE NOCASE OR email=? COLLATE NOCASE',
    args: [login, login],
  });
  log('PASS: Configured database is reachable');
  if (result.rows.length !== 1)
    throw new BackendCheckError(
      'Account was not uniquely found in this database. Check the username/email and database configuration.',
    );
  const user = result.rows[0];
  log('PASS: Account found');
  if (Number(user.is_active) !== 1)
    throw new BackendCheckError(
      'Account is inactive. Login is blocked even with the correct password.',
    );
  log('PASS: Account is active');
  if (user.role !== 'ADMIN')
    throw new BackendCheckError(
      'Account is not an administrator. The upload test requires an ADMIN account.',
    );
  log('PASS: Account has ADMIN role');
  if (!isLegacyHash(user.password_hash) && !isPepperedPasswordHash(user.password_hash))
    throw new BackendCheckError(
      'Stored password format is unsupported or damaged. No password or account was changed.',
    );
  const valid = isLegacyHash(user.password_hash)
    ? await verifyLegacyPassword(password, user.password_hash)
    : await new PasswordHasher(pepper).verify(password, user.password_hash);
  if (!valid)
    throw new BackendCheckError(
      'Password does not match the stored account in this database. Check Caps Lock, keyboard layout, and the password used during admin:create. No account was changed.',
    );
  log('PASS: Password matches the stored account');
  if (isLegacyHash(user.password_hash))
    log('INFO: This account still needs the peppered Worker password migration.');
  log('LOGIN DATABASE CHECK PASSED');
  log('This read-only check did not create a session, upload files, or change any records.');
}

async function main() {
  const credentials = await readStdinCredentials();
  const url = process.env.TURSO_DATABASE_URL ?? 'file:.local/karaoke.db';
  if (url.startsWith('file:')) console.log('Database target: local SQLite');
  else {
    const target = new URL(url);
    if (!['libsql:', 'https:'].includes(target.protocol) || target.username || target.password)
      throw new BackendCheckError(
        'Use a libsql:// or https:// database URL without embedded credentials.',
      );
    console.log('Database target: ' + target.hostname);
  }
  const db = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
  try {
    await checkLogin({ db, ...credentials });
  } finally {
    credentials.password = '';
    db.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(
      error instanceof BackendCheckError
        ? 'FAIL: ' + error.message
        : 'FAIL: Database check could not complete. Check the database URL/token and network. No raw error or credentials were printed.',
    );
    process.exitCode = 1;
  });
}
