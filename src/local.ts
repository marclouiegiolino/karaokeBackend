import { mkdir } from 'node:fs/promises';
import { createClient } from '@libsql/client';
import { loadConfiguration } from './Main/Configuration.js';
import { buildDependencies } from './Main/Dependencies.js';
import { R2FileStorage } from './Modules/Services/R2FileStorage.js';
import { createApp } from './app.js';
if (process.env.APP_ENV && process.env.APP_ENV !== 'development')
  throw new Error('Local Node server is development-only; use the Workers adapter for production');
await mkdir('.local', { recursive: true });
const config = loadConfiguration({
  ...process.env,
  APP_ENV: 'development',
  TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL ?? 'file:.local/karaoke.db',
});
const db = createClient({ url: config.TURSO_DATABASE_URL, authToken: config.TURSO_AUTH_TOKEN });
const app = createApp(buildDependencies(config, db, new R2FileStorage(config)));
const server = app.listen(Number(process.env.PORT ?? 8787), '127.0.0.1', () =>
  console.log('Karaoke API: http://localhost:' + String(process.env.PORT ?? 8787) + '/api/health'),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () =>
    server.close(() => {
      db.close();
      process.exit(0);
    }),
  );
