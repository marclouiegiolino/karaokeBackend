import { Router } from 'express';
import type { Dependencies } from '../Main/Dependencies.js';
import { SongController } from '../Controllers/SongController.js';
import { errorHandler } from '../Middleware/ErrorHandler.js';
import { requireAdmin } from '../Middleware/RequireAdmin.js';
import { rateLimit } from '../Middleware/RateLimit.js';
import { validateRequest } from '../Middleware/ValidateRequest.js';
import { createSongSchema } from '../DTOs/Song/CreateSongRequest.js';
import { updateSongSchema } from '../DTOs/Song/UpdateSongRequest.js';
import { uploadSongSchema } from '../DTOs/Song/UploadSongRequest.js';
import { transcribeSongSchema } from '../DTOs/Song/TranscribeSongRequest.js';
export function songRoutes(d: Dependencies) {
  const r = Router(),
    c = new SongController(d);
  r.get('/', c.list);
  r.get('/:id', c.get);
  r.post('/', requireAdmin, validateRequest(createSongSchema), c.create);
  r.patch('/:id', requireAdmin, validateRequest(updateSongSchema), c.update);
  r.post('/:id/archive', requireAdmin, c.archive);
  r.post('/:id/uploads', requireAdmin, validateRequest(uploadSongSchema), c.upload);
  r.post('/:id/uploads/complete', requireAdmin, c.complete);
  r.post('/:id/publish', requireAdmin, c.publish);
  r.post(
    '/:id/lyrics/transcribe',
    requireAdmin,
    rateLimit(d, 'ai'),
    validateRequest(transcribeSongSchema),
    c.transcribeLyrics,
  );
  r.get('/:id/download', c.download);
  r.use(errorHandler);
  return r;
}
