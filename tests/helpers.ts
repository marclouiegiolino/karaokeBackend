import { createClient } from '@libsql/client';
import { migrate } from '../scripts/migration-runner.js';
import { loadConfiguration } from '../src/Main/Configuration.js';
import { buildDependencies } from '../src/Main/Dependencies.js';
import { createApp } from '../src/app.js';
import { digest, newToken } from '../src/Security/TokenService.js';
import type { IFileStorage } from '../src/Modules/Services/IFileStorage.js';
import type { UserRecord } from '../src/Modules/User/User.js';
import { sqlitePipelineDatabase } from './turso-fixture.js';
export const origin = 'http://localhost:3000';
export class FakeStorage implements IFileStorage {
  objects = new Map<string, { bytes: Uint8Array; type: string }>();
  uploadUrl(key: string) {
    return Promise.resolve('https://storage.invalid/' + key);
  }
  downloadUrl(key: string) {
    return Promise.resolve('https://storage.invalid/' + key + '?signed=true');
  }
  async head(key: string) {
    const o = this.objects.get(key);
    if (!o) throw Object.assign(new Error('Not found'), { name: 'NotFound' });
    return { byteSize: o.bytes.length, contentType: o.type, etag: 'etag-' + key };
  }
  async read(key: string, max: number) {
    const o = this.objects.get(key)!;
    if (o.bytes.length > max) throw new Error('too large');
    return o.bytes;
  }
  async prefix(key: string, n: number) {
    return this.objects.get(key)!.bytes.slice(0, n);
  }
  async promote(source: string, destination: string) {
    this.objects.set(destination, this.objects.get(source)!);
  }
  async remove(key: string) {
    this.objects.delete(key);
  }
  put(key: string, value: string | Uint8Array, type: string) {
    this.objects.set(key, {
      bytes: typeof value === 'string' ? new TextEncoder().encode(value) : value,
      type,
    });
  }
}
export async function fixture() {
  const db = createClient({ url: 'file::memory:' });
  await migrate(db);
  const config = loadConfiguration({
    APP_ENV: 'development',
    TURSO_DATABASE_URL: 'file::memory:',
    FRONTEND_ORIGINS: origin,
    REGISTRATION_ENABLED: 'true',
    PASSWORD_PEPPER: 'test-only-karaoke-pepper-32-characters-minimum',
  });
  const storage = new FakeStorage();
  const allow = { limit: async () => ({ success: true }) };
  const testDatabase =
    process.env.KARAOKE_TEST_NATIVE_DB === 'true' ? sqlitePipelineDatabase(db).native : db;
  const d = buildDependencies(config, testDatabase, storage, { api: allow, auth: allow });
  async function account(role: 'USER' | 'ADMIN', name: string) {
    const id = crypto.randomUUID();
    const u: UserRecord = {
      id,
      username: name,
      email: name + '@example.com',
      display_name: name,
      password_hash: 'not-used-for-session-fixtures',
      role,
      is_active: 1,
      created_at: Date.now(),
    };
    await d.users.create(u);
    const token = newToken();
    await db.execute({
      sql: 'INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)',
      args: [crypto.randomUUID(), id, digest(token), Date.now() + 3600000, Date.now()],
    });
    return { user: u, cookie: 'karaoke_session=' + token };
  }
  return {
    db,
    d,
    storage,
    app: createApp(d),
    admin: await account('ADMIN', 'admin'),
    alice: await account('USER', 'alice'),
    bob: await account('USER', 'bob'),
  };
}
