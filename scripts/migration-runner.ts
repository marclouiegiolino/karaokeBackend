import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Client } from '@libsql/client';
export async function migrate(db: Client) {
  await db.execute('PRAGMA foreign_keys=ON');
  await db.execute(
    'CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at INTEGER NOT NULL)',
  );
  const dir = new URL('../src/Migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter((n) => /^\d+_.+\.sql$/.test(n)).sort()) {
    const sql = await readFile(new URL(file, dir), 'utf8'),
      checksum = createHash('sha256').update(sql).digest('hex');
    const tx = await db.transaction('write');
    try {
      const existing = await tx.execute({
        sql: 'SELECT checksum FROM schema_migrations WHERE name=?',
        args: [file],
      });
      if (existing.rows.length) {
        if (existing.rows[0]!.checksum !== checksum)
          throw new Error(`Applied migration changed: ${file}`);
        await tx.commit();
        continue;
      }
      await tx.executeMultiple(sql);
      await tx.execute({
        sql: 'INSERT INTO schema_migrations(name,checksum,applied_at) VALUES(?,?,?)',
        args: [file, checksum, Date.now()],
      });
      await tx.commit();
      console.log('Applied migration:', file);
    } finally {
      tx.close();
    }
  }
}
