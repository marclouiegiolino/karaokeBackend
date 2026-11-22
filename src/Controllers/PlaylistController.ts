import type { RequestHandler } from 'express';
import type { Dependencies } from '../Main/Dependencies.js';
import { paginationSchema } from '../Main/Pagination.js';
import { songResponse } from '../Modules/Song/Song.js';
export class PlaylistController {
  constructor(private d: Dependencies) {}
  list: RequestHandler = async (req, res) => {
    const q = paginationSchema.parse(req.query);
    res.json({ data: await this.d.playlists.list(res.locals.user.id, q.page, q.pageSize), ...q });
  };
  create: RequestHandler = async (_req, res) => {
    res
      .status(201)
      .json({ data: await this.d.playlists.create(res.locals.user.id, res.locals.input) });
  };
  get: RequestHandler = async (req, res) => {
    const id = String(req.params.id);
    const playlist = await this.d.playlistService.owned(id, res.locals.user.id);
    res.json({
      data: {
        ...playlist,
        songs: (await this.d.playlists.songs(id)).map((s) => ({
          ...songResponse(s),
          position: s.position,
        })),
      },
    });
  };
  update: RequestHandler = async (req, res) => {
    const id = String(req.params.id);
    await this.d.playlistService.owned(id, res.locals.user.id);
    res.json({ data: await this.d.playlists.update(id, res.locals.input) });
  };
  remove: RequestHandler = async (req, res) => {
    const id = String(req.params.id);
    await this.d.playlistService.owned(id, res.locals.user.id);
    await this.d.playlists.remove(id);
    res.status(204).end();
  };
  addSong: RequestHandler = async (req, res) => {
    await this.d.playlistService.addSong(
      String(req.params.id),
      res.locals.input.songId,
      res.locals.user.id,
    );
    res.status(204).end();
  };
  removeSong: RequestHandler = async (req, res) => {
    const id = String(req.params.id);
    await this.d.playlistService.owned(id, res.locals.user.id);
    await this.d.playlists.removeSong(id, String(req.params.songId));
    res.status(204).end();
  };
}
