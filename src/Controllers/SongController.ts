import type { RequestHandler } from 'express';
import * as z from 'zod';
import type { Dependencies } from '../Main/Dependencies.js';
import { paginationSchema } from '../Main/Pagination.js';
import { songResponse } from '../Modules/Song/Song.js';

const songListQuerySchema = paginationSchema.extend({
  search: z.string().max(100).default(''),
  drafts: z.enum(['true', 'false']).default('false'),
});
const completeUploadBodySchema = z.object({ uploadId: z.uuid() }).strict();
const uuidRe =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000)$/i;

function parseCompleteUploadBody(raw: unknown): { uploadId: string } {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const uploadId = obj.uploadId;
    if (typeof uploadId === 'string' && uuidRe.test(uploadId) && Object.keys(obj).length === 1) {
      return { uploadId };
    }
  }
  return completeUploadBodySchema.parse(raw);
}

export class SongController {
  constructor(private d: Dependencies) {}
  list: RequestHandler = async (req, res) => {
    const q = songListQuerySchema.parse(req.query);
    const admin = res.locals.user.role === 'ADMIN' && q.drafts === 'true';
    res.json({
      data: (await this.d.songs.list(q.page, q.pageSize, q.search, admin)).map(songResponse),
      page: q.page,
      pageSize: q.pageSize,
    });
  };
  get: RequestHandler = async (req, res) => {
    res.json({
      data: songResponse(
        await this.d.songService.get(String(req.params.id), res.locals.user.role === 'ADMIN'),
      ),
    });
  };
  create: RequestHandler = async (_req, res) => {
    res.status(201).json({
      data: songResponse(await this.d.songs.create(res.locals.input, res.locals.user.id)),
    });
  };
  update: RequestHandler = async (req, res) => {
    await this.d.songService.get(String(req.params.id), true);
    res.json({
      data: songResponse((await this.d.songs.update(String(req.params.id), res.locals.input))!),
    });
  };
  archive: RequestHandler = async (req, res) => {
    await this.d.songService.get(String(req.params.id), true);
    res.json({ data: songResponse((await this.d.songService.archive(String(req.params.id)))!) });
  };
  upload: RequestHandler = async (req, res) => {
    res.status(201).json(await this.d.songService.upload(String(req.params.id), res.locals.input));
  };
  complete: RequestHandler = async (req, res) => {
    const { uploadId } = parseCompleteUploadBody(req.body);
    res.json({
      data: songResponse(await this.d.songService.complete(String(req.params.id), uploadId)),
    });
  };
  publish: RequestHandler = async (req, res) => {
    res.json({ data: songResponse((await this.d.songService.publish(String(req.params.id)))!) });
  };
  download: RequestHandler = async (req, res) => {
    res.json(await this.d.songService.download(String(req.params.id)));
  };
  transcribeLyrics: RequestHandler = async (req, res) => {
    res.json({
      data: await this.d.transcription.transcribeSong(String(req.params.id), res.locals.input),
    });
  };
}
