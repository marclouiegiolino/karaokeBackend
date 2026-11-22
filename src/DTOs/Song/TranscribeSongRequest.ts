import * as z from 'zod';

export const transcribeSongSchema = z
  .object({
    language: z
      .string()
      .trim()
      .min(2)
      .max(16)
      .regex(/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/)
      .optional(),
  })
  .strict()
  .default({});

export type TranscribeSongRequest = z.infer<typeof transcribeSongSchema>;
