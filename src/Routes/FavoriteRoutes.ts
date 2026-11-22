import { Router } from 'express';
import type { Dependencies } from '../Main/Dependencies.js';
import { FavoriteController } from '../Controllers/FavoriteController.js';
import { errorHandler } from '../Middleware/ErrorHandler.js';
export function favoriteRoutes(d: Dependencies) {
  const r = Router(),
    c = new FavoriteController(d);
  r.get('/', c.list);
  r.put('/:songId', c.add);
  r.delete('/:songId', c.remove);
  r.use(errorHandler);
  return r;
}
