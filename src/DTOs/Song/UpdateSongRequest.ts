import { createSongSchema } from './CreateSongRequest.js';
export const updateSongSchema = createSongSchema
  .pick({ title: true, artist: true, genre: true, language: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field');
