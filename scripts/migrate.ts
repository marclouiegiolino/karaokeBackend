import { mkdir } from 'node:fs/promises';
import { createClient } from '@libsql/client';
import { migrate } from './migration-runner.js';
await mkdir('.local', { recursive: true });
const url = process.env.TURSO_DATABASE_URL ?? 'file:.local/karaoke.db';
if (!url.startsWith('file:') && process.env.CONFIRM_REMOTE_MIGRATION !== 'yes')
  throw new Error(
    'Set CONFIRM_REMOTE_MIGRATION=yes deliberately before changing a remote database',
  );
const db = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
try {
  await migrate(db);
} finally {
  db.close();
}
