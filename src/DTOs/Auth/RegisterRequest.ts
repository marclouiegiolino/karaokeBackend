import * as z from 'zod';
export const registerSchema = z
  .object({
    username: z
      .string()
      .trim()
      .min(3)
      .max(40)
      .regex(/^[a-zA-Z0-9_]+$/)
      .transform((s) => s.toLowerCase()),
    email: z
      .email()
      .max(254)
      .transform((s) => s.toLowerCase()),
    displayName: z.string().trim().min(1).max(80),
    password: z.string().min(8).max(128),
  })
  .strict();
export type RegisterRequest = z.infer<typeof registerSchema>;
