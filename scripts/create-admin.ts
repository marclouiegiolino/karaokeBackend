import { createInterface } from 'node:readline/promises';
import { createClient } from '@libsql/client';
import { UserRepository } from '../src/Modules/User/UserRepository.js';
import { registerSchema } from '../src/DTOs/Auth/RegisterRequest.js';
import { PasswordHasher } from '../src/Security/PasswordHasher.js';
async function secret(): Promise<string> {
  if (!process.stdin.isTTY)
    throw new Error('Use an interactive terminal or supply ADMIN_PASSWORD through the environment');
  process.stdout.write('Password (hidden; follows RegisterRequest.ts policy): ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const clean = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    };
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === '\u0003') {
          clean();
          reject(new Error('Cancelled'));
          return;
        }
        if (c === '\r' || c === '\n') {
          clean();
          resolve(value);
          return;
        }
        if (c === '\u007f' || c === '\b') {
          value = value.slice(0, -1);
        } else if (c >= ' ') value += c;
      }
    };
    process.stdin.on('data', onData);
  });
}
const rl = createInterface({ input: process.stdin, output: process.stdout });
const username = process.env.ADMIN_USERNAME ?? (await rl.question('Administrator username: '));
const email = process.env.ADMIN_EMAIL ?? (await rl.question('Administrator email: '));
const displayName = process.env.ADMIN_DISPLAY_NAME ?? (await rl.question('Display name: '));
rl.close();
const password = process.env.ADMIN_PASSWORD ?? (await secret());
const input = registerSchema.parse({ username, email, displayName, password });
const db = createClient({
  url: process.env.TURSO_DATABASE_URL ?? 'file:.local/karaoke.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
});
try {
  await new UserRepository(db).create({
    id: crypto.randomUUID(),
    username: input.username,
    email: input.email,
    display_name: input.displayName,
    password_hash: await new PasswordHasher(process.env.PASSWORD_PEPPER).hash(input.password),
    role: 'ADMIN',
    is_active: 1,
    created_at: Date.now(),
  });
  console.log('Administrator created. No credentials were printed.');
} finally {
  db.close();
}
