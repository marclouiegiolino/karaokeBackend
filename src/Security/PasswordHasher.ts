import { timingSafeEqual } from 'node:crypto';
import { AppError } from '../Utils/AppError.js';

// User-approved Romantic Album approach: HMAC pepper, then PBKDF2-SHA256.
export const PASSWORD_ITERATIONS = 12_000;
export const PASSWORD_PREFIX = '$pbkdf2-sha256$';
const EXACT_PREFIX = '$pbkdf2-sha256$12000$';
const encoder = new TextEncoder();
const dummySalt = new Uint8Array(32);
const dummyExpected = new Uint8Array(32);
const HEX_64_RE = /^[a-f0-9]{64}$/;

export function isPepperedPasswordHash(encoded: unknown): encoded is string {
  return (
    typeof encoded === 'string' &&
    encoded.length === 150 &&
    encoded.startsWith(EXACT_PREFIX) &&
    encoded.charCodeAt(85) === 36 &&
    HEX_64_RE.test(encoded.slice(21, 85)) &&
    HEX_64_RE.test(encoded.slice(86, 150))
  );
}

export class PasswordHasher {
  private pepperKey?: Promise<CryptoKey>;
  private resolvedKey?: CryptoKey;
  private readonly validPepper: boolean;
  constructor(private pepper?: string) {
    this.validPepper =
      typeof pepper === 'string' &&
      pepper.length >= 32 &&
      pepper.length <= 512 &&
      pepper.trim() === pepper;
    if (this.validPepper) {
      void this.key();
    }
  }
  private key(): CryptoKey | Promise<CryptoKey> {
    if (!this.validPepper)
      throw new AppError(503, 'AUTH_UNAVAILABLE', 'Authentication is temporarily unavailable');
    if (this.resolvedKey) return this.resolvedKey;
    return (this.pepperKey ??= crypto.subtle
      .importKey('raw', encoder.encode(this.pepper!), { name: 'HMAC', hash: 'SHA-256' }, false, [
        'sign',
      ])
      .then((k) => (this.resolvedKey = k)));
  }
  private async derive(password: string, salt: Uint8Array<ArrayBuffer>) {
    const hmacKey = this.resolvedKey ?? (await this.key());
    const peppered = await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(password));
    const key = await crypto.subtle.importKey('raw', peppered, 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PASSWORD_ITERATIONS },
      key,
      256,
    );
    return new Uint8Array(bits);
  }
  async hash(password: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const key = await this.derive(password, salt);
    return `${EXACT_PREFIX}${Buffer.from(salt.buffer, salt.byteOffset, salt.byteLength).toString('hex')}$${Buffer.from(key.buffer, key.byteOffset, key.byteLength).toString('hex')}`;
  }
  async verify(password: string, encoded: string): Promise<boolean> {
    // Malformed, unknown and legacy hashes do dummy work; never invoke an unsupported cost.
    const valid = isPepperedPasswordHash(encoded);
    const salt = valid
      ? (Buffer.from(encoded.slice(21, 85), 'hex') as unknown as Uint8Array<ArrayBuffer>)
      : dummySalt;
    const expected = valid ? Buffer.from(encoded.slice(86, 150), 'hex') : dummyExpected;
    const actual = await this.derive(password, salt);
    const equal = timingSafeEqual(actual, expected);
    return valid && equal;
  }
}
