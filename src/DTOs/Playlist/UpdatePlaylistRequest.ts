import { createPlaylistSchema } from './CreatePlaylistRequest.js';
export const updatePlaylistSchema = createPlaylistSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field');
