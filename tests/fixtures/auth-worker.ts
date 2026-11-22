import { PasswordHasher } from '../../src/Security/PasswordHasher.js';

export default {
  async fetch() {
    // Simulate the hosted limit which local workerd otherwise does not enforce.
    const original = crypto.subtle.deriveBits.bind(crypto.subtle);
    let maximumIterations = 0;
    Object.defineProperty(crypto.subtle, 'deriveBits', {
      configurable: true,
      value: (algorithm: Pbkdf2Params, key: CryptoKey, length: number) => {
        maximumIterations = Math.max(maximumIterations, algorithm.iterations ?? 0);
        if (algorithm.iterations > 100000)
          throw new DOMException('Test production iteration ceiling', 'NotSupportedError');
        return original(algorithm, key, length);
      },
    });
    try {
      const pepper = 'fixture-only-random-looking-karaoke-pepper-32-plus';
      const hasher = new PasswordHasher(pepper);
      const password = 'fixture password';
      const hash = await hasher.hash(password);
      const valid = await hasher.verify(password, hash);
      const wrong = await hasher.verify('different password', hash);
      const legacy = await hasher.verify(
        password,
        'pbkdf2-sha256$600000$' + '00'.repeat(16) + '$' + '00'.repeat(32),
      );
      const wrongPepper = await new PasswordHasher(pepper + 'other').verify(password, hash);
      return Response.json({
        valid,
        wrong,
        legacy,
        wrongPepper,
        maximumIterations,
        newFormat: /^\$pbkdf2-sha256\$12000\$[a-f0-9]{64}\$[a-f0-9]{64}$/.test(hash),
      });
    } finally {
      Object.defineProperty(crypto.subtle, 'deriveBits', { configurable: true, value: original });
    }
  },
};
