import type { RequestHandler } from 'express';
import type { Dependencies } from '../Main/Dependencies.js';
import { paginationSchema } from '../Main/Pagination.js';
import { songResponse } from '../Modules/Song/Song.js';
export class FavoriteController {
  constructor(private d: Dependencies) {}
  list: RequestHandler = async (req, res) => {
    const q = paginationSchema.parse(req.query);
    res.json({
      data: (await this.d.favorites.list(res.locals.user.id, q.page, q.pageSize)).map(songResponse),
      ...q,
    });
  };
  add: RequestHandler = async (req, res) => {
    const id = String(req.params.songId);
    await this.d.songService.get(id);
    await this.d.favorites.add(res.locals.user.id, id);
    res.status(204).end();
  };
  remove: RequestHandler = async (req, res) => {
    await this.d.favorites.remove(res.locals.user.id, String(req.params.songId));
    res.status(204).end();
  };
}
