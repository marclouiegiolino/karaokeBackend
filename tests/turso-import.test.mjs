import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createClient } from '@libsql/client';
import { copyKaraokeDatabase } from '../scripts/import-local-to-turso.mjs';
const schema = await readFile(
  new URL('../src/Migrations/0001_initial.sql', import.meta.url),
  'utf8',
);
async function source() {
  const c = createClient({ url: 'file::memory:', intMode: 'bigint' });
  await c.execute(
    'CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at INTEGER NOT NULL)',
  );
  await c.executeMultiple(schema);
  await c.execute({
    sql: 'INSERT INTO schema_migrations VALUES(?,?,?)',
    args: ['0001_initial.sql', 'test-checksum', 1],
  });
  await c.execute({
    sql: 'INSERT INTO users(id,username,email,display_name,password_hash,role,created_at) VALUES(?,?,?,?,?,?,?)',
    args: [
      'user-1',
      'micaela',
      'micaela@example.com',
      'Micaela',
      'test-only-password-hash',
      'ADMIN',
      123,
    ],
  });
  return c;
}
const target = () => createClient({ url: 'file::memory:', intMode: 'bigint' });
async function objects(c) {
  return (
    await c.execute(
      "SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL",
    )
  ).rows;
}

test('dry run reads source and leaves target empty', async () => {
  const s = await source(),
    t = target();
  try {
    const r = await copyKaraokeDatabase(s, t);
    assert.equal(r.destinationChanged, false);
    assert.equal((await objects(t)).length, 0);
    assert.equal(r.tables.find((x) => x.table === 'users').rows, 1);
  } finally {
    s.close();
    t.close();
  }
});
test('import preserves administrator, hash, schema migration metadata and budget', async () => {
  const s = await source(),
    t = target();
  try {
    const r = await copyKaraokeDatabase(s, t, { apply: true });
    assert.equal(r.verified, true);
    const u = (await t.execute('SELECT * FROM users')).rows[0];
    assert.equal(u.username, 'micaela');
    assert.equal(u.password_hash, 'test-only-password-hash');
    assert.equal(u.role, 'ADMIN');
    assert.equal(
      (await t.execute('SELECT checksum FROM schema_migrations')).rows[0].checksum,
      'test-checksum',
    );
    assert.equal(
      (await t.execute('SELECT limit_bytes FROM storage_budget')).rows[0].limit_bytes,
      2000000000n,
    );
    assert.equal((await s.execute('SELECT COUNT(*) AS n FROM users')).rows[0].n, 1n);
  } finally {
    s.close();
    t.close();
  }
});
test('existing destination schema is refused without overwriting', async () => {
  const s = await source(),
    t = target();
  try {
    await t.execute('CREATE TABLE keep_me(value TEXT)');
    await t.execute("INSERT INTO keep_me VALUES('keep')");
    await assert.rejects(copyKaraokeDatabase(s, t, { apply: true }), /already contains/);
    assert.equal((await t.execute('SELECT value FROM keep_me')).rows[0].value, 'keep');
    assert.equal((await objects(t)).length, 1);
  } finally {
    s.close();
    t.close();
  }
});
test('retry after success refuses to duplicate or overwrite imported accounts', async () => {
  const s = await source(),
    t = target();
  try {
    await copyKaraokeDatabase(s, t, { apply: true });
    await assert.rejects(copyKaraokeDatabase(s, t, { apply: true }), /already contains/);
    assert.equal((await t.execute('SELECT COUNT(*) AS n FROM users')).rows[0].n, 1n);
  } finally {
    s.close();
    t.close();
  }
});
test('verification failure rolls back the entire target import', async () => {
  const s = await source(),
    t = target();
  const wrapped = {
    execute: t.execute.bind(t),
    transaction: async (mode) => {
      const tx = await t.transaction(mode);
      const execute = tx.execute.bind(tx);
      let corrupt = false;
      tx.execute = async (statement) => {
        if (typeof statement === 'string' && statement === 'SELECT * FROM "users"' && !corrupt) {
          corrupt = true;
          await execute("UPDATE users SET display_name='changed'");
        }
        return execute(statement);
      };
      return tx;
    },
  };
  try {
    await assert.rejects(copyKaraokeDatabase(s, wrapped, { apply: true }), /did not match/);
    assert.equal((await objects(t)).length, 0);
  } finally {
    s.close();
    t.close();
  }
});
test('unrelated source database is refused', async () => {
  const s = target(),
    t = target();
  try {
    await s.execute('CREATE TABLE unrelated(id INTEGER)');
    await assert.rejects(copyKaraokeDatabase(s, t, { apply: true }), /not the expected/);
    assert.equal((await objects(t)).length, 0);
  } finally {
    s.close();
    t.close();
  }
});
