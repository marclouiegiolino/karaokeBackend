import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, pbkdf2Sync } from 'node:crypto';
import { PasswordHasher, isPepperedPasswordHash } from '../src/Security/PasswordHasher.js';
import { loadConfiguration } from '../src/Main/Configuration.js';

const pepper = 'test-only-dedicated-karaoke-pepper-32-plus-characters';
const password = '  caf\u00e9-\u2665-current-password  ';
test('HMAC-peppered PBKDF2 matches an independent Node implementation', async () => {
  const salt = Buffer.alloc(32, 17);
  const expected = pbkdf2Sync(
    createHmac('sha256', pepper).update(password).digest(),
    salt,
    12000,
    32,
    'sha256',
  );
  const encoded = '$pbkdf2-sha256$12000$' + salt.toString('hex') + '$' + expected.toString('hex');
  assert.equal(await new PasswordHasher(pepper).verify(password, encoded), true);
  assert.equal(await new PasswordHasher(pepper).verify(password.trim(), encoded), false);
  assert.equal(await new PasswordHasher(pepper + 'different').verify(password, encoded), false);
});
test('new hashes use separate random 32-byte salts and the versioned peppered format', async () => {
  const hasher = new PasswordHasher(pepper);
  const first = await hasher.hash(password),
    second = await hasher.hash(password);
  assert.equal(isPepperedPasswordHash(first), true);
  assert.notEqual(first, second);
  assert.equal(await hasher.verify(password, first), true);
  assert.equal(await hasher.verify('wrong', first), false);
  assert.equal(first.includes(pepper), false);
});
test('missing or invalid peppers fail closed without exposing their value', async () => {
  for (const value of [undefined, '', 'short', ' '.repeat(32), 'x'.repeat(513)]) {
    await assert.rejects(new PasswordHasher(value).hash(password), (error) => {
      assert.equal((error as { code: string }).code, 'AUTH_UNAVAILABLE');
      assert.equal((error as { status: number }).status, 503);
      return true;
    });
  }
});
test('legacy, malformed and oversized-cost hashes do dummy work at 12000, never 600000', async () => {
  const original = crypto.subtle.deriveBits.bind(crypto.subtle);
  const observed: number[] = [];
  const spy = mock.method(
    crypto.subtle,
    'deriveBits',
    (algorithm: Pbkdf2Params, key: CryptoKey, length: number) => {
      observed.push(algorithm.iterations);
      assert.equal(algorithm.iterations, 12000);
      return original(algorithm, key, length);
    },
  );
  try {
    const hasher = new PasswordHasher(pepper);
    for (const hash of [
      '',
      'garbage',
      'pbkdf2-sha256$600000$' + '00'.repeat(16) + '$' + '00'.repeat(32),
      '$pbkdf2-sha256$9999999999$' + '00'.repeat(32) + '$' + '00'.repeat(32),
    ]) {
      assert.equal(await hasher.verify(password, hash), false);
    }
    assert.deepEqual(observed, [12000, 12000, 12000, 12000]);
  } finally {
    spy.mock.restore();
  }
});
test('production requires a dedicated password pepper without using SERVICE_SECRET as fallback', () => {
  const config = {
    APP_ENV: 'production',
    FRONTEND_ORIGINS: 'https://karaoke.example.com',
    TURSO_DATABASE_URL: 'libsql://not-contacted.turso.io',
    TURSO_AUTH_TOKEN: 'fake',
    R2_ACCOUNT_ID: 'fake',
    R2_BUCKET: 'fake',
    R2_ACCESS_KEY_ID: 'fake',
    R2_SECRET_ACCESS_KEY: 'fake',
    SERVICE_SECRET: pepper,
  };
  assert.throws(() => loadConfiguration(config), /PASSWORD_PEPPER/);
  assert.equal(loadConfiguration({ ...config, PASSWORD_PEPPER: pepper }).PASSWORD_PEPPER, pepper);
});
