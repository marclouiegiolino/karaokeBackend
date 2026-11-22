import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createClient } from '@libsql/client';
import { PasswordHasher } from '../src/Security/PasswordHasher.ts';
import { checkLogin } from '../scripts/check-login.mjs';
import { readCredentials as readStdinCredentials } from '../scripts/test-live-auth.mjs';

const password = '  test-private-cafe-\u00e9-\u2665  ';
const pepper = 'test-only-karaoke-dedicated-pepper-32-characters';
const hash = new PasswordHasher(pepper).hash(password);
async function fixture(overrides = {}) {
  const db = createClient({ url: 'file::memory:' });
  await db.execute(
    'CREATE TABLE users(username TEXT, email TEXT, role TEXT, is_active INTEGER, password_hash TEXT)',
  );
  await db.execute({
    sql: 'INSERT INTO users VALUES(?,?,?,?,?)',
    args: [
      'micaela',
      'admin@example.test',
      overrides.role ?? 'ADMIN',
      overrides.is_active ?? 1,
      overrides.password_hash ?? (await hash),
    ],
  });
  const statements = [],
    logs = [];
  return {
    db,
    statements,
    logs,
    options: {
      login: 'MICAELA',
      pepper,
      password,
      log: (line) => logs.push(line),
      db: {
        execute: async (statement) => {
          statements.push(statement);
          assert.match(statement.sql, /^SELECT /);
          return db.execute(statement);
        },
      },
    },
  };
}
test('read-only login diagnosis verifies real SQLite account and actual password hash', async () => {
  const f = await fixture();
  try {
    await checkLogin(f.options);
    assert.ok(f.logs.includes('PASS: Password matches the stored account'));
    assert.equal(f.statements.length, 1);
    assert.deepEqual(f.statements[0].args, ['MICAELA', 'MICAELA']);
    assert.equal((await f.db.execute('SELECT COUNT(*) AS n FROM users')).rows[0].n, 1);
    assert.equal(f.logs.join('\n').includes(password), false);
    assert.equal(f.logs.join('\n').includes(await hash), false);
  } finally {
    f.db.close();
  }
});
for (const [label, overrides, input, expected] of [
  ['wrong password', {}, { password: 'incorrect-private-password' }, /does not match/],
  ['missing account', {}, { login: 'not-present' }, /not uniquely found/],
  ['inactive account', { is_active: 0 }, {}, /inactive/],
  ['non-admin account', { role: 'USER' }, {}, /not an administrator/],
  ['unsupported verifier', { password_hash: 'bad-private-hash' }, {}, /unsupported or damaged/],
]) {
  test('login diagnosis identifies ' + label + ' without writing to the database', async () => {
    const f = await fixture(overrides);
    try {
      await assert.rejects(checkLogin({ ...f.options, ...input }), expected);
      assert.equal(f.statements.length, 1);
      assert.equal(f.logs.join('\n').includes(await hash), false);
    } finally {
      f.db.close();
    }
  });
}
test('PowerShell stdin supports BOM, split UTF-8, quotes and password spaces', async () => {
  const bytes = Buffer.from(
    '\uFEFF' + JSON.stringify({ login: ' micaela ', password: password + '"\\' }),
  );
  const result = await readStdinCredentials(Readable.from([...bytes].map((b) => Buffer.from([b]))));
  assert.deepEqual(result, { login: 'micaela', password: password + '"\\' });
});
test('credential input rejects oversized and malformed input without reflecting secrets', async () => {
  await assert.rejects(
    readStdinCredentials(Readable.from(['private-malformed-input'])),
    (error) => {
      assert.equal(error.message.includes('private-malformed-input'), false);
      return /Could not read credentials/.test(error.message);
    },
  );
  await assert.rejects(readStdinCredentials(Readable.from(['x'.repeat(8193)])), /exceeds/);
});
