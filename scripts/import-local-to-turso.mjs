import { createClient } from '@libsql/client';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const EXPECTED_TABLES = new Set([
  'schema_migrations',
  'users',
  'sessions',
  'songs',
  'playlists',
  'playlist_songs',
  'favorites',
  'performances',
  'storage_budget',
  'uploads',
]);
const MAX_ROWS = 100_000;

export class ImportError extends Error {}
const identifier = (name) => '"' + String(name).replaceAll('"', '""') + '"';
const schemaSql = `SELECT type,name,tbl_name,sql FROM sqlite_schema
 WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%'
 AND sql IS NOT NULL ORDER BY type,name`;

function fingerprint(result) {
  const encode = (v) => {
    if (v === null) return ['null'];
    if (typeof v === 'bigint') return ['integer', v.toString()];
    if (v instanceof ArrayBuffer) return ['blob', Buffer.from(v).toString('base64')];
    if (ArrayBuffer.isView(v))
      return ['blob', Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64')];
    return [typeof v, v];
  };
  const rows = result.rows
    .map((row) => JSON.stringify(result.columns.map((c) => encode(row[c]))))
    .sort();
  const hash = createHash('sha256').update(JSON.stringify(result.columns));
  for (const row of rows) hash.update(String(Buffer.byteLength(row)) + ':' + row);
  return hash.digest('hex');
}

async function orderedTables(source, tables) {
  const pending = new Map();
  const names = new Set(tables.map((t) => String(t.name)));
  for (const table of tables) {
    const foreignKeys = await source.execute(`PRAGMA foreign_key_list(${identifier(table.name)})`);
    const parents = new Set(
      foreignKeys.rows.map((r) => String(r.table)).filter((n) => n !== table.name),
    );
    for (const parent of parents) {
      if (!names.has(parent))
        throw new ImportError('Source contains a foreign key to a missing table.');
    }
    pending.set(String(table.name), parents);
  }
  const result = [];
  while (pending.size) {
    const ready = [...pending].filter(([, parents]) => parents.size === 0).map(([name]) => name);
    if (!ready.length)
      throw new ImportError(
        'Source has cyclic table dependencies; this helper will not import it.',
      );
    for (const name of ready) {
      result.push(tables.find((t) => t.name === name));
      pending.delete(name);
      for (const parents of pending.values()) parents.delete(name);
    }
  }
  return result;
}

/** Copy this karaoke project's schema and data. The caller owns both clients. */
export async function copyKaraokeDatabase(sourceClient, targetClient, { apply = false } = {}) {
  const source = await sourceClient.transaction('read');
  let target;
  try {
    const check = await source.execute('PRAGMA integrity_check');
    if (check.rows.length !== 1 || String(check.rows[0][check.columns[0]]) !== 'ok') {
      throw new ImportError('Local database failed integrity_check. Import was not started.');
    }
    if ((await source.execute('PRAGMA foreign_key_check')).rows.length) {
      throw new ImportError('Local database has broken foreign keys. Import was not started.');
    }
    const schema = (await source.execute(schemaSql)).rows;
    const tables = schema.filter((o) => o.type === 'table');
    const names = new Set(tables.map((t) => String(t.name)));
    if (names.size !== EXPECTED_TABLES.size || [...EXPECTED_TABLES].some((n) => !names.has(n))) {
      throw new ImportError(
        'Source is not the expected karaoke database. No destination changes were made.',
      );
    }
    if (
      schema.some((o) => !['table', 'index'].includes(String(o.type))) ||
      tables.some((t) => /CREATE\s+VIRTUAL/i.test(String(t.sql)))
    ) {
      throw new ImportError('This helper supports the original karaoke tables and indexes only.');
    }
    const order = await orderedTables(source, tables);
    const snapshots = new Map();
    const report = [];
    let total = 0;
    for (const table of order) {
      const count = await source.execute(`SELECT COUNT(*) AS n FROM ${identifier(table.name)}`);
      const n = Number(count.rows[0].n);
      total += n;
      if (total > MAX_ROWS)
        throw new ImportError('This small-project importer is limited to 100,000 total rows.');
      const data = await source.execute(`SELECT * FROM ${identifier(table.name)}`);
      snapshots.set(table.name, { data, digest: fingerprint(data) });
      report.push({ table: String(table.name), rows: n });
    }
    const existing = await targetClient.execute(schemaSql);
    if (existing.rows.length) {
      throw new ImportError(
        'Destination already contains tables or other schema objects. Nothing was overwritten. Use an empty destination; do not delete an existing database just to bypass this check.',
      );
    }
    if (!apply)
      return { mode: 'dry-run', tables: report, totalRows: total, destinationChanged: false };

    target = await targetClient.transaction('write');
    if ((await target.execute(schemaSql)).rows.length) {
      throw new ImportError('Destination changed after the check. Import was cancelled.');
    }
    await target.executeMultiple(order.map((t) => String(t.sql) + ';').join('\n'));
    const inserts = [];
    for (const table of order) {
      const { data } = snapshots.get(table.name);
      const sql = `INSERT INTO ${identifier(table.name)} (${data.columns.map(identifier).join(',')}) VALUES (${data.columns.map(() => '?').join(',')})`;
      for (const row of data.rows) inserts.push({ sql, args: data.columns.map((c) => row[c]) });
    }
    for (let i = 0; i < inserts.length; i += 100) await target.batch(inserts.slice(i, i + 100));
    const indexes = schema.filter((o) => o.type === 'index');
    if (indexes.length)
      await target.executeMultiple(indexes.map((o) => String(o.sql) + ';').join('\n'));
    for (const table of order) {
      const actual = await target.execute(`SELECT * FROM ${identifier(table.name)}`);
      if (fingerprint(actual) !== snapshots.get(table.name).digest) {
        throw new ImportError(
          'Copied data did not match the source. The import transaction will be rolled back.',
        );
      }
    }
    if ((await target.execute('PRAGMA foreign_key_check')).rows.length) {
      throw new ImportError(
        'Destination foreign-key verification failed. The transaction will be rolled back.',
      );
    }
    const integrity = await target.execute('PRAGMA integrity_check');
    if (integrity.rows.length !== 1 || String(integrity.rows[0][integrity.columns[0]]) !== 'ok') {
      throw new ImportError(
        'Destination integrity verification failed. The transaction will be rolled back.',
      );
    }
    await target.commit();
    return {
      mode: 'imported',
      tables: report,
      totalRows: total,
      destinationChanged: true,
      verified: true,
    };
  } finally {
    target?.close();
    source.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  let apply = false,
    sourcePath = '.local/karaoke.db';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') apply = true;
    else if (args[i] === '--dry-run') {
      /* Read-only default. */
    } else if (args[i] === '--source' && args[i + 1]) sourcePath = args[++i];
    else
      throw new ImportError(
        'Usage: node --env-file=.dev.vars scripts/import-local-to-turso.mjs [--dry-run | --apply] [--source PATH]',
      );
  }
  const url = process.env.TURSO_DATABASE_URL,
    authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url?.startsWith('libsql://') || !authToken) {
    throw new ImportError(
      'Set TURSO_DATABASE_URL to your remote libsql:// URL and TURSO_AUTH_TOKEN in .dev.vars first.',
    );
  }
  const path = resolve(sourcePath);
  const info = await stat(path).catch(() => {
    throw new ImportError(
      'Local database file was not found. Run this command from C:\\Karaoke\\backend.',
    );
  });
  if (!info.isFile() || info.size > 50_000_000)
    throw new ImportError('Source must be a SQLite file smaller than 50 MB.');
  console.log('Source:', path);
  console.log('Destination:', new URL(url).hostname);
  console.log(
    apply ? 'Mode: import into empty destination' : 'Mode: read-only check; no destination changes',
  );
  const source = createClient({ url: pathToFileURL(path).href, intMode: 'bigint' });
  const target = createClient({ url, authToken, intMode: 'bigint' });
  try {
    const result = await copyKaraokeDatabase(source, target, { apply });
    console.table(result.tables);
    console.log(
      result.mode === 'imported'
        ? 'Import committed. Row contents and foreign keys verified. Local database retained.'
        : 'Check passed. Run the same command with --apply to import.',
    );
  } finally {
    source.close();
    target.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(
      error instanceof ImportError
        ? error.message
        : `Import failed (${error.code ?? error.name ?? 'unknown error'}). Check credentials/connectivity without sharing secrets. If the connection failed during commit, inspect the destination before retrying.`,
    );
    process.exitCode = 1;
  });
}
