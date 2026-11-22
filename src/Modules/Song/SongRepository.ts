import { BaseRepository } from '../../Main/BaseRepository.js';
import type { ISongRepository } from './ISongRepository.js';
import type { Song } from './Song.js';
import type { CreateSongRequest } from '../../DTOs/Song/CreateSongRequest.js';
import type { UploadSongRequest } from '../../DTOs/Song/UploadSongRequest.js';
import { AppError } from '../../Utils/AppError.js';
export interface Upload {
  id: string;
  song_id: string;
  kind: 'audio' | 'cover' | 'package';
  staging_key: string;
  final_key: string;
  content_type: string;
  byte_size: number;
  status: string;
  expires_at: number;
  created_at: number;
}
export class SongRepository extends BaseRepository implements ISongRepository {
  findById(id: string) {
    return this.first<Song>('SELECT * FROM songs WHERE id=?', [id]);
  }
  list(page: number, pageSize: number, search: string, includeDrafts: boolean) {
    const term = '%' + search.replace(/[\\%_]/g, '\\$&') + '%';
    return this.rows<Song>(
      "SELECT * FROM songs WHERE (?=1 OR status='PUBLISHED') AND (title LIKE ? ESCAPE '\\' OR artist LIKE ? ESCAPE '\\') ORDER BY title,id LIMIT ? OFFSET ?",
      [includeDrafts ? 1 : 0, term, term, pageSize, (page - 1) * pageSize],
    );
  }
  async create(input: CreateSongRequest, userId: string) {
    const id = crypto.randomUUID(),
      now = Date.now();
    await this.db.execute({
      sql: 'INSERT INTO songs(id,title,artist,genre,language,duration_ms,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
      args: [
        id,
        input.title,
        input.artist,
        input.genre ?? null,
        input.language ?? null,
        input.durationMs,
        userId,
        now,
        now,
      ],
    });
    return (await this.findById(id))!;
  }
  async update(id: string, input: Record<string, unknown>) {
    const values = Object.entries(input).filter(([key]) =>
      ['title', 'artist', 'genre', 'language'].includes(key),
    );
    if (values.length)
      await this.db.execute({
        sql: `UPDATE songs SET ${values.map(([key]) => key + '=?').join(',')},updated_at=? WHERE id=?`,
        args: [...values.map(([, value]) => String(value)), Date.now(), id],
      });
    return this.findById(id);
  }
  async transition(id: string, status: 'PUBLISHED' | 'ARCHIVED') {
    const extra =
      status === 'PUBLISHED'
        ? "AND status='DRAFT' AND audio_key IS NOT NULL AND package_key IS NOT NULL"
        : '';
    const result = await this.db.execute({
      sql: `UPDATE songs SET status=?,updated_at=? WHERE id=? ${extra} AND NOT EXISTS(SELECT 1 FROM uploads WHERE song_id=? AND status IN ('PENDING','PROCESSING'))`,
      args: [status, Date.now(), id, id],
    });
    if (!result.rowsAffected)
      throw new AppError(409, 'SONG_STATE', 'Finish active uploads before changing song status');
    return this.findById(id);
  }
  async status(id: string, status: Song['status']) {
    await this.db.execute({
      sql: 'UPDATE songs SET status=?,updated_at=? WHERE id=?',
      args: [status, Date.now(), id],
    });
    return this.findById(id);
  }
  getUpload(id: string) {
    return this.first<Upload>('SELECT * FROM uploads WHERE id=?', [id]);
  }
  findUploadForCompletion(songId: string, uploadId: string) {
    type CompletionRow = (Upload | { id: null }) & {
      song_status: Song['status'];
      duration_ms: number;
      package_version: number;
    };
    return this.first<CompletionRow>(
      `SELECT u.*, s.status AS song_status, s.duration_ms, s.package_version
       FROM songs AS s
       LEFT JOIN uploads AS u ON u.song_id = s.id AND u.id = ?
       WHERE s.id = ?`,
      [uploadId, songId],
    );
  }
  async claimForCompletion(
    songId: string,
    uploadId: string,
  ): Promise<
    | { status: 'NOT_FOUND_SONG' }
    | { status: 'NOT_FOUND_UPLOAD' }
    | { status: 'COMPLETE'; song: Song; kind: Upload['kind'] }
    | { status: 'UNAVAILABLE'; kind: Upload['kind'] }
    | {
        status: 'CLAIMED';
        upload: Upload & {
          song_status: Song['status'];
          duration_ms: number;
          package_version: number;
        };
      }
  > {
    const claimed = await this.first<{
      kind: Upload['kind'];
      staging_key: string;
      final_key: string;
      content_type: string;
      byte_size: number;
      expires_at: number;
      created_at: number;
      duration_ms: number;
      package_version: number;
    }>(
      `UPDATE uploads
       SET status = 'PROCESSING'
       WHERE id = ? AND song_id = ? AND status = 'PENDING' AND expires_at > ?
         AND EXISTS (SELECT 1 FROM songs WHERE id = song_id AND status = 'DRAFT')
       RETURNING kind, staging_key, final_key, content_type, byte_size, expires_at, created_at,
         (SELECT duration_ms FROM songs WHERE id = song_id) AS duration_ms,
         (SELECT package_version FROM songs WHERE id = song_id) AS package_version`,
      [uploadId, songId, Date.now()],
    );
    if (claimed)
      return {
        status: 'CLAIMED',
        upload: {
          id: uploadId,
          song_id: songId,
          status: 'PROCESSING',
          song_status: 'DRAFT',
          ...claimed,
        },
      };

    const row = await this.findUploadForCompletion(songId, uploadId);
    if (!row) return { status: 'NOT_FOUND_SONG' };
    if (row.id === null) return { status: 'NOT_FOUND_UPLOAD' };
    if (row.status === 'COMPLETE') {
      const song = await this.findById(songId);
      if (song) return { status: 'COMPLETE', song, kind: row.kind };
    }
    return { status: 'UNAVAILABLE', kind: row.kind };
  }
  reserve(song: Song, input: UploadSongRequest) {
    return this.reserveForSong(song.id, input, true);
  }
  async reserveForSong(songId: string, input: UploadSongRequest, assetValid = true) {
    if (assetValid) {
      const id = crypto.randomUUID(),
        now = Date.now(),
        assetSuffix = `${input.kind}-${id}`,
        stagingKey = `_staging/${id}`,
        expiresAt = now + 900000;
      // Expiration releases reservations; lifecycle rules delete staging objects separately.
      const results = await this.db.batch(
        [
          {
            sql: "UPDATE storage_budget SET reserved_bytes=reserved_bytes-COALESCE((SELECT SUM(byte_size) FROM uploads WHERE status='PENDING' AND expires_at<?1),0) WHERE id=1 AND EXISTS(SELECT 1 FROM uploads WHERE status='PENDING' AND expires_at<?1) AND (SELECT status FROM songs WHERE id=?2)='DRAFT'",
            args: [now, songId],
          },
          {
            sql: "UPDATE uploads SET status='EXPIRED' WHERE status='PENDING' AND expires_at<? AND (SELECT status FROM songs WHERE id=?)='DRAFT'",
            args: [now, songId],
          },
          {
            sql: "DELETE FROM uploads WHERE song_id=?1 AND kind=?2 AND status='EXPIRED' AND (SELECT status FROM songs WHERE id=?1)='DRAFT' AND EXISTS(SELECT 1 FROM storage_budget WHERE id=1 AND used_bytes+reserved_bytes+?3<=limit_bytes)",
            args: [songId, input.kind, input.byteSize],
          },
          {
            sql: "UPDATE storage_budget SET reserved_bytes=reserved_bytes+?1 WHERE id=1 AND used_bytes+reserved_bytes+?1<=limit_bytes AND (SELECT status FROM songs WHERE id=?2)='DRAFT' AND NOT EXISTS(SELECT 1 FROM uploads WHERE song_id=?2 AND kind=?3)",
            args: [input.byteSize, songId, input.kind],
          },
          {
            sql: "INSERT INTO uploads(id,song_id,kind,staging_key,final_key,content_type,byte_size,expires_at,created_at) SELECT ?1,?2,?3,?4,('songs/' || s.id || '/v' || s.package_version || '/' || ?5),?6,?7,?8,?9 FROM songs AS s WHERE s.id=?2 AND changes()=1 RETURNING final_key",
            args: [
              id,
              songId,
              input.kind,
              stagingKey,
              assetSuffix,
              input.contentType,
              input.byteSize,
              expiresAt,
              now,
            ],
          },
        ],
        'write',
      );
      const finalKey = results[4]?.rows[0]?.final_key;
      if (results[3]?.rowsAffected && typeof finalKey === 'string') {
        return {
          id,
          song_id: songId,
          kind: input.kind,
          staging_key: stagingKey,
          final_key: finalKey,
          content_type: input.contentType,
          byte_size: input.byteSize,
          status: 'PENDING',
          expires_at: expiresAt,
          created_at: now,
        };
      }
    }
    const diag = await this.first<{
      song_status?: string | null;
      upload_status?: string | null;
    }>(
      'SELECT (SELECT status FROM songs WHERE id=?1) AS song_status,(SELECT status FROM uploads WHERE song_id=?1 AND kind=?2) AS upload_status',
      [songId, input.kind],
    );
    if (diag?.song_status == null) throw new AppError(404, 'NOT_FOUND', 'Song not found');
    if (diag.song_status !== 'DRAFT')
      throw new AppError(409, 'IMMUTABLE_MEDIA', 'Only draft songs accept media uploads');
    if (!assetValid) throw new AppError(400, 'INVALID_ASSET', 'Unsupported content type or size');
    if (diag.upload_status && diag.upload_status !== 'EXPIRED')
      throw new AppError(
        409,
        'UPLOAD_EXISTS',
        'This asset already has an upload; finish it before creating another',
      );
    throw new AppError(409, 'STORAGE_BUDGET', 'Application storage budget reached');
  }
  async claim(id: string) {
    const result = await this.db.execute({
      sql: "UPDATE uploads SET status='PROCESSING' WHERE id=? AND status='PENDING' AND expires_at>?",
      args: [id, Date.now()],
    });
    return result.rowsAffected > 0;
  }
  async reset(id: string) {
    await this.db.execute({
      sql: "UPDATE uploads SET status='PENDING' WHERE id=? AND status='PROCESSING'",
      args: [id],
    });
  }
  async complete(upload: Upload): Promise<Song | undefined> {
    const column = { audio: 'audio_key', cover: 'cover_key', package: 'package_key' }[upload.kind];
    const results = await this.db.batch(
      [
        {
          sql: "UPDATE uploads SET status='COMPLETE' WHERE id=? AND status='PROCESSING' AND EXISTS(SELECT 1 FROM songs WHERE id=song_id AND status='DRAFT')",
          args: [upload.id],
        },
        {
          sql: `UPDATE songs SET ${column}=?,updated_at=? WHERE id=? AND status='DRAFT' AND changes()=1 RETURNING *`,
          args: [upload.final_key, Date.now(), upload.song_id],
        },
        {
          sql: 'UPDATE storage_budget SET reserved_bytes=reserved_bytes-?1,used_bytes=used_bytes+?1 WHERE id=1 AND changes()=1',
          args: [upload.byte_size],
        },
      ],
      'write',
    );
    if (!results[0]?.rowsAffected) {
      const current = await this.getUpload(upload.id);
      if (current?.status !== 'PROCESSING')
        throw new AppError(409, 'UPLOAD_STATE', 'Upload state changed');
      throw new AppError(409, 'SONG_STATE', 'Song is no longer a draft');
    }
    return results[1]?.rows[0] as unknown as Song | undefined;
  }
}
