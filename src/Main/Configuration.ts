import * as z from 'zod';
const schema = z.object({
  APP_ENV: z.enum(['development', 'preview', 'production']).default('development'),
  FRONTEND_ORIGINS: z.string().min(1).default('http://localhost:3000,http://127.0.0.1:3000'),
  TURSO_DATABASE_URL: z.string().min(1),
  TURSO_AUTH_TOKEN: z.string().optional(),
  PASSWORD_PEPPER: z.string().min(32).max(512).optional(),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  REGISTRATION_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  SESSION_HOURS: z.coerce.number().int().min(1).max(168).default(24),
});
export type Configuration = z.infer<typeof schema> & { origins: string[] };
export function loadConfiguration(raw: unknown): Configuration {
  const config = schema.parse(raw);
  const origins = config.FRONTEND_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!origins.length) throw new Error('At least one frontend origin is required');
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.origin !== origin || url.username || url.password)
      throw new Error('Use exact origins without paths');
    if (
      config.APP_ENV !== 'development' &&
      (url.protocol !== 'https:' || url.hostname.endsWith('.invalid'))
    ) {
      throw new Error('Configure a real HTTPS frontend origin before deployment');
    }
  }
  if (config.APP_ENV !== 'development') {
    if (!config.PASSWORD_PEPPER) throw new Error('PASSWORD_PEPPER is required before deployment');
    if (!config.TURSO_DATABASE_URL.startsWith('libsql://') || !config.TURSO_AUTH_TOKEN)
      throw new Error('Remote Turso credentials are required');
    for (const name of [
      'R2_ACCOUNT_ID',
      'R2_BUCKET',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
    ] as const) {
      if (!config[name]) throw new Error(`Missing ${name}`);
    }
  }
  return { ...config, origins };
}
