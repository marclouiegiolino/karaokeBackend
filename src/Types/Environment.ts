export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}
export interface Environment {
  APP_ENV?: string;
  FRONTEND_ORIGINS?: string;
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
  PASSWORD_PEPPER?: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  SESSION_HOURS?: string;
  REGISTRATION_ENABLED?: string;
  API_LIMITER?: RateLimitBinding;
  AUTH_LIMITER?: RateLimitBinding;
  MEDIA_BUCKET?: R2Bucket;
}
