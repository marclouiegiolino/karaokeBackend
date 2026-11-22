import { Router } from 'express';
import * as z from 'zod';
import type { Dependencies } from '../Main/Dependencies.js';
import { PlaylistController } from '../Controllers/PlaylistController.js';
import { errorHandler } from '../Middleware/ErrorHandler.js';
import { validateRequest } from '../Middleware/ValidateRequest.js';
import { createPlaylistSchema } from '../DTOs/Playlist/CreatePlaylistRequest.js';
import { updatePlaylistSchema } from '../DTOs/Playlist/UpdatePlaylistRequest.js';

const addPlaylistSongSchema = z.object({ songId: z.uuid() }).strict();

export function playlistRoutes(d: Dependencies) {
  const r = Router(),
    c = new PlaylistController(d);
  r.get('/', c.list);
  r.post('/', validateRequest(createPlaylistSchema), c.create);
  r.get('/:id', c.get);
  r.patch('/:id', validateRequest(updatePlaylistSchema), c.update);
  r.delete('/:id', c.remove);
  r.post('/:id/songs', validateRequest(addPlaylistSongSchema), c.addSong);
  r.delete('/:id/songs/:songId', c.removeSong);
  r.use(errorHandler);
  return r;
}
