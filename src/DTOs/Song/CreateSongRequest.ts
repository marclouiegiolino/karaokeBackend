import * as z from 'zod';
export const createSongSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    artist: z.string().trim().min(1).max(200),
    genre: z.string().trim().max(60).optional(),
    language: z.string().trim().max(60).optional(),
    durationMs: z.number().int().min(1000).max(1800000),
  })
  .strict();
export type CreateSongRequest = z.infer<typeof createSongSchema>;
