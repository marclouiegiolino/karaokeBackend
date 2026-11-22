import * as z from 'zod';
import type { FastValidatedSchema } from '../../Middleware/ValidateRequest.js';
export const loginSchema: FastValidatedSchema<{ login: string; password: string }> = z
  .object({ login: z.string().trim().min(1).max(254), password: z.string().min(1).max(128) })
  .strict();
loginSchema._fastParse = (raw: unknown) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const login = obj.login;
  const password = obj.password;
  if (typeof login !== 'string' || typeof password !== 'string') return undefined;
  if (password.length < 1 || password.length > 128) return undefined;
  for (const key in obj) {
    if (key !== 'login' && key !== 'password') return undefined;
  }
  const trimmed = login.trim();
  if (trimmed.length < 1 || trimmed.length > 254) return undefined;
  return { login: trimmed, password };
};
export type LoginRequest = z.infer<typeof loginSchema>;
