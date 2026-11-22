import * as z from 'zod';
export const createPlaylistSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(500).default(''),
  })
  .strict();
export type CreatePlaylistRequest = z.infer<typeof createPlaylistSchema>;
