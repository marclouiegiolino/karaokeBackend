import { Router } from 'express';
import type { Dependencies } from '../Main/Dependencies.js';
import { authenticate } from '../Middleware/Authenticate.js';
import { errorHandler } from '../Middleware/ErrorHandler.js';
import { authenticationRoutes } from './AuthenticationRoutes.js';
import { songRoutes } from './SongRoutes.js';
import { playlistRoutes } from './PlaylistRoutes.js';
import { favoriteRoutes } from './FavoriteRoutes.js';
import { performanceRoutes } from './PerformanceRoutes.js';
export function routes(d: Dependencies) {
  const r = Router();
  r.get('/health', (_req, res) =>
    res.json({ status: 'ok', service: 'karaoke-backend', version: '0.1.0' }),
  );
  r.use('/auth', authenticationRoutes(d));
  r.use(authenticate(d));
  r.use('/songs', songRoutes(d));
  r.use('/playlists', playlistRoutes(d));
  r.use('/favorites', favoriteRoutes(d));
  r.use('/performances', performanceRoutes(d));
  r.use(errorHandler);
  return r;
}
