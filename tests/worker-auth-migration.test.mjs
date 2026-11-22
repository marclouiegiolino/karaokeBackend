import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { pbkdf2Sync } from 'node:crypto';
import { mkdtemp, readFile, writeFile, readdir, rm, stat, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseEnv } from 'node:util';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { PasswordHasher } from '../src/Security/PasswordHasher.ts';
import { migrateAccount, preparePepper } from '../scripts/worker-auth-migration.mjs';
import { migrate } from '../scripts/migration-runner.ts';

const pepper = 'test-only-dedicated-karaoke-pepper-32-plus-characters';
const password = '  current-caf\u00e9-\u2665-password  ';
const salt = Buffer.alloc(16, 15);
const legacy =
  'pbkdf2-sha256$600000$' +
  salt.toString('hex') +
  '$' +
  pbkdf2Sync(password, salt, 600000, 32, 'sha256').toString('hex');
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'karaoke-password-test-'));
  const db = createClient({ url: 'file::memory:' });
  await migrate(db);
  for (const [id, name, role] of [
    ['admin', 'micaela', 'ADMIN'],
    ['other', 'other', 'USER'],
  ]) {
    await db.execute({
      sql: 'INSERT INTO users(id,username,email,display_name,password_hash,role,is_active,created_at) VALUES(?,?,?,?,?,?,1,0)',
      args: [id, name, name + '@example.test', name, legacy, role],
    });
    await db.execute({
      sql: 'INSERT INTO sessions VALUES(?,?,?,?,?)',
      args: [id, id, id + '-token-hash', Date.now() + 100000, 0],
    });
  }
  const logs = [];
  return {
    db,
    directory,
    logs,
    options: {
      db,
      login: 'MICAELA',
      password,
      pepper,
      backupDirectory: join(directory, 'backups'),
      log: (line) => logs.push(line),
    },
    close: async () => {
      db.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
const account = async (db) => (await db.execute("SELECT * FROM users WHERE id='admin'")).rows[0];
test('migration dry run verifies the real legacy password without changing records or writing backups', async () => {
  const f = await fixture();
  try {
    const before = await account(f.db);
    const result = await migrateAccount(f.options);
    assert.equal(result.changed, false);
    assert.deepEqual(await account(f.db), before);
    assert.equal((await f.db.execute('SELECT COUNT(*) AS n FROM sessions')).rows[0].n, 2);
    await assert.rejects(access(f.options.backupDirectory), { code: 'ENOENT' });
  } finally {
    await f.close();
  }
});
test('migration preserves the same password, other account data, and a local old-hash backup', async () => {
  const f = await fixture();
  try {
    const before = await account(f.db);
    const result = await migrateAccount({ ...f.options, apply: true, requireAdmin: true });
    const after = await account(f.db);
    assert.deepEqual({ ...after, password_hash: before.password_hash }, before);
    assert.equal(await new PasswordHasher(pepper).verify(password, after.password_hash), true);
    assert.equal(
      (await f.db.execute("SELECT password_hash FROM users WHERE id='other'")).rows[0]
        .password_hash,
      legacy,
    );
    assert.deepEqual(
      (await f.db.execute('SELECT user_id FROM sessions')).rows.map((row) => row.user_id),
      ['other'],
    );
    const backup = JSON.parse(await readFile(result.backupPath, 'utf8'));
    assert.equal(backup.previousPasswordHash, legacy);
    assert.equal(backup.userId, 'admin');
    if (process.platform !== 'win32')
      assert.equal((await stat(result.backupPath)).mode & 0o777, 0o600);
    const output = f.logs.join('\n');
    assert.equal(output.includes(password), false);
    assert.equal(output.includes(pepper), false);
    assert.equal(output.includes(legacy), false);
    assert.equal(JSON.stringify(backup).includes(password), false);
    assert.equal(JSON.stringify(backup).includes(pepper), false);
  } finally {
    await f.close();
  }
});
test('wrong current password cannot change hashes or sessions', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      migrateAccount({ ...f.options, password: 'incorrect', apply: true }),
      /did not match/,
    );
    assert.equal((await account(f.db)).password_hash, legacy);
    assert.equal((await f.db.execute('SELECT COUNT(*) AS n FROM sessions')).rows[0].n, 2);
    await assert.rejects(access(f.options.backupDirectory), { code: 'ENOENT' });
  } finally {
    await f.close();
  }
});
test('a session-revocation failure rolls back the hash update and retains its backup', async () => {
  const f = await fixture();
  try {
    await f.db.execute(
      "CREATE TRIGGER fail_revocation BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT,'test rollback'); END",
    );
    await assert.rejects(migrateAccount({ ...f.options, apply: true }));
    assert.equal((await account(f.db)).password_hash, legacy);
    assert.equal((await f.db.execute('SELECT COUNT(*) AS n FROM sessions')).rows[0].n, 2);
    assert.equal((await readdir(f.options.backupDirectory)).length, 1);
  } finally {
    await f.close();
  }
});
test('a concurrent password change is not overwritten', async () => {
  const f = await fixture();
  try {
    const wrapper = {
      execute: (statement) => f.db.execute(statement),
      transaction: async (mode) => {
        await f.db.execute(
          "UPDATE users SET password_hash='changed-concurrently' WHERE id='admin'",
        );
        return f.db.transaction(mode);
      },
    };
    await assert.rejects(
      migrateAccount({ ...f.options, db: wrapper, apply: true }),
      /changed during migration/,
    );
    assert.equal((await account(f.db)).password_hash, 'changed-concurrently');
    assert.equal((await f.db.execute('SELECT COUNT(*) AS n FROM sessions')).rows[0].n, 2);
  } finally {
    await f.close();
  }
});
test('retries keep the same peppered hash and existing new sessions; wrong peppers fail closed', async () => {
  const f = await fixture();
  try {
    await migrateAccount({ ...f.options, apply: true });
    const hash = (await account(f.db)).password_hash;
    await f.db.execute({
      sql: 'INSERT INTO sessions VALUES(?,?,?,?,?)',
      args: ['new', 'admin', 'new-token', Date.now() + 100000, 0],
    });
    const result = await migrateAccount({ ...f.options, apply: true });
    assert.equal(result.alreadyMigrated, true);
    assert.equal((await account(f.db)).password_hash, hash);
    assert.equal((await readdir(f.options.backupDirectory)).length, 1);
    assert.equal((await f.db.execute('SELECT COUNT(*) AS n FROM sessions')).rows[0].n, 2);
    await assert.rejects(
      migrateAccount({ ...f.options, pepper: pepper + 'different', apply: true }),
      /does not match/,
    );
    assert.equal((await account(f.db)).password_hash, hash);
  } finally {
    await f.close();
  }
});
test('a lost commit reply can be safely retried without replacing a committed hash', async () => {
  const f = await fixture();
  try {
    const wrapper = {
      execute: (statement) => f.db.execute(statement),
      transaction: async (mode) => {
        const tx = await f.db.transaction(mode);
        return {
          execute: (statement) => tx.execute(statement),
          rollback: () => tx.rollback(),
          close: () => tx.close(),
          commit: async () => {
            await tx.commit();
            throw new Error('test lost acknowledgement');
          },
        };
      },
    };
    await assert.rejects(migrateAccount({ ...f.options, db: wrapper, apply: true }));
    const committed = (await account(f.db)).password_hash;
    assert.equal(await new PasswordHasher(pepper).verify(password, committed), true);
    assert.equal((await migrateAccount({ ...f.options, apply: true })).alreadyMigrated, true);
    assert.equal((await account(f.db)).password_hash, committed);
  } finally {
    await f.close();
  }
});
for (const existingCount of [0, 1]) {
  test(
    'pepper setup handles ' +
      existingCount +
      ' already-peppered accounts without accidental rotation',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'karaoke-pepper-test-'));
      try {
        const envPath = join(directory, '.dev.vars');
        const original =
          '# retain this comment\r\nTURSO_DATABASE_URL=libsql://not-contacted.turso.io\r\nTURSO_AUTH_TOKEN=test-only\r\nR2_BUCKET=karaoke-media\r\n';
        await writeFile(envPath, original);
        let reads = 0;
        const dbFactory = () => ({
          execute: async () => {
            reads++;
            return { rows: [{ count: existingCount }] };
          },
          close() {},
        });
        const logs = [];
        if (existingCount) {
          await assert.rejects(
            preparePepper({ envPath, dbFactory, log: (line) => logs.push(line) }),
            /Restore the existing pepper/,
          );
          assert.equal(await readFile(envPath, 'utf8'), original);
        } else {
          const key = await preparePepper({ envPath, dbFactory, log: (line) => logs.push(line) });
          assert.match(key, /^[A-Za-z0-9_-]{43}$/);
          const text = await readFile(envPath, 'utf8');
          assert.equal(text.startsWith(original), true);
          assert.equal(parseEnv(text).PASSWORD_PEPPER, key);
          assert.equal(
            await preparePepper({ envPath, dbFactory, log: (line) => logs.push(line) }),
            key,
          );
          assert.equal(reads, 1);
          assert.equal(logs.join('\n').includes(key), false);
        }
        assert.deepEqual((await readdir(directory)).sort(), ['.dev.vars']);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}

test('new local projects can explicitly prepare their pepper after schema migration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'karaoke-local-pepper-test-'));
  const dbPath = join(directory, 'local.db');
  const envPath = join(directory, '.dev.vars');
  try {
    // Native libSQL handles can outlive close() until finalization on Windows.
    // Exit the process that owns the file before the parent removes its directory.
    const source = `
      import assert from 'node:assert/strict';
      import { createClient } from '@libsql/client';
      import { writeFile, readFile } from 'node:fs/promises';
      import { parseEnv } from 'node:util';
      const { migrate } = await import(${JSON.stringify(new URL('../scripts/migration-runner.ts', import.meta.url).href)});
      const { preparePepper } = await import(${JSON.stringify(new URL('../scripts/worker-auth-migration.mjs', import.meta.url).href)});
      const [dbPath, envPath] = process.argv.slice(1);
      const db = createClient({ url: 'file:' + dbPath });
      try { await migrate(db); } finally { db.close(); }
      await writeFile(envPath, 'TURSO_DATABASE_URL=file:' + dbPath + '\\nTURSO_AUTH_TOKEN=\\n');
      await assert.rejects(preparePepper({ envPath, log: () => {} }), /remote libsql/);
      const key = await preparePepper({ envPath, allowLocal: true, log: () => {} });
      assert.match(key, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(parseEnv(await readFile(envPath, 'utf8')).PASSWORD_PEPPER, key);
    `;
    await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', source, dbPath, envPath],
      { cwd: new URL('../', import.meta.url), timeout: 30000 },
    );
    assert.match(parseEnv(await readFile(envPath, 'utf8')).PASSWORD_PEPPER, /^[A-Za-z0-9_-]{43}$/);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
