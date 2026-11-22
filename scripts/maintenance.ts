import { createClient } from '@libsql/client';
import { loadConfiguration } from '../src/Main/Configuration.js';
import { SongRepository } from '../src/Modules/Song/SongRepository.js';
import type { Upload } from '../src/Modules/Song/SongRepository.js';
import { R2FileStorage } from '../src/Modules/Services/R2FileStorage.js';
const config = loadConfiguration({
  ...process.env,
  TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL ?? 'file:.local/karaoke.db',
});
const db = createClient({ url: config.TURSO_DATABASE_URL, authToken: config.TURSO_AUTH_TOKEN });
try {
  const repository = new SongRepository(db),
    storage = new R2FileStorage(config);
  const stuck = await db.execute({
    sql: "SELECT * FROM uploads WHERE status='PROCESSING' AND expires_at<?",
    args: [Date.now() - 300000],
  });
  for (const row of stuck.rows) {
    const u = row as unknown as Upload;
    try {
      const h = await storage.head(u.final_key);
      if (h.byteSize !== u.byte_size)
        throw new Error('Canonical upload size mismatch; inspect manually');
      await repository.complete(u);
      console.log('Recovered completed upload:', u.id);
    } catch (e) {
      if (
        (e as { name?: string }).name === 'NotFound' ||
        (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
      ) {
        await repository.reset(u.id);
        console.log('Reset interrupted upload:', u.id);
      } else throw e;
    }
  }
  const cutoff = Date.now();
  const tx = await db.transaction('write');
  try {
    const expired = await tx.execute({
      sql: "SELECT COALESCE(SUM(byte_size),0) AS bytes FROM uploads WHERE status='PENDING' AND expires_at<?",
      args: [cutoff],
    });
    await tx.execute({
      sql: 'UPDATE storage_budget SET reserved_bytes=reserved_bytes-? WHERE id=1',
      args: [Number(expired.rows[0]?.bytes ?? 0)],
    });
    await tx.execute({
      sql: "UPDATE uploads SET status='EXPIRED' WHERE status='PENDING' AND expires_at<?",
      args: [cutoff],
    });
    await tx.execute({ sql: 'DELETE FROM sessions WHERE expires_at<?', args: [cutoff] });
    await tx.commit();
  } finally {
    tx.close();
  }
  console.log('Maintenance complete. Keep R2 staging expiration enabled.');
} finally {
  db.close();
}
