import { SongRepository } from '../Song/SongRepository.js';
import type { Upload } from '../Song/SongRepository.js';
import { parseSongPackage } from '../Song/SongPackage.js';
import type { IFileStorage } from './IFileStorage.js';
import type { UploadSongRequest } from '../../DTOs/Song/UploadSongRequest.js';
import { AppError } from '../../Utils/AppError.js';
const utf8Decoder = new TextDecoder();
const types = {
  audio: ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4'],
  cover: ['image/jpeg', 'image/png', 'image/webp'],
  package: ['application/json'],
};
const limits = { audio: 20000000, cover: 300000, package: 1000000 };

function eq4(b: Uint8Array, offset: number, c0: number, c1: number, c2: number, c3: number) {
  return b[offset] === c0 && b[offset + 1] === c1 && b[offset + 2] === c2 && b[offset + 3] === c3;
}

function isValidMediaSignature(contentType: string, bytes: Uint8Array): boolean {
  const b0 = bytes[0];
  switch (contentType) {
    case 'audio/mpeg':
      return (
        (b0 === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) ||
        (b0 === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)
      );
    case 'audio/wav':
      return eq4(bytes, 0, 0x52, 0x49, 0x46, 0x46) && eq4(bytes, 8, 0x57, 0x41, 0x56, 0x45);
    case 'audio/ogg':
      return eq4(bytes, 0, 0x4f, 0x67, 0x67, 0x53);
    case 'audio/mp4':
      return eq4(bytes, 4, 0x66, 0x74, 0x79, 0x70);
    case 'image/jpeg':
      return b0 === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/png':
      return eq4(bytes, 0, 0x89, 0x50, 0x4e, 0x47);
    case 'image/webp':
      return eq4(bytes, 0, 0x52, 0x49, 0x46, 0x46) && eq4(bytes, 8, 0x57, 0x45, 0x42, 0x50);
    default:
      return false;
  }
}
export class SongService {
  constructor(
    private songs: SongRepository,
    private storage: IFileStorage,
  ) {}
  async get(id: string, admin = false) {
    const song = await this.songs.findById(id);
    if (!song || (!admin && song.status !== 'PUBLISHED'))
      throw new AppError(404, 'NOT_FOUND', 'Song not found');
    return song;
  }
  async upload(id: string, input: UploadSongRequest) {
    const assetValid =
      types[input.kind].includes(input.contentType) && input.byteSize <= limits[input.kind];
    // Sign only server-generated keys; no arbitrary keys or URLs are accepted.
    const upload = await this.songs.reserveForSong(id, input, assetValid);
    return {
      uploadId: upload.id,
      url: await this.storage.uploadUrl(upload.staging_key, input.contentType, input.byteSize),
      method: 'PUT',
      headers: { 'Content-Type': input.contentType },
      expiresIn: 300,
    };
  }
  async complete(songId: string, uploadId: string) {
    const startedAt = performance.now();
    const stages: Record<string, number> = {};
    let kind: Upload['kind'] | 'unknown' = 'unknown';
    const measure = async <T>(stage: string, work: () => Promise<T>): Promise<T> => {
      const stageStartedAt = performance.now();
      try {
        return await work();
      } finally {
        stages[stage] = Number((performance.now() - stageStartedAt).toFixed(2));
      }
    };
    const measureSync = <T>(stage: string, work: () => T): T => {
      const stageStartedAt = performance.now();
      try {
        return work();
      } finally {
        stages[stage] = Number((performance.now() - stageStartedAt).toFixed(2));
      }
    };

    try {
      const outcome = await measure('claim', () => this.songs.claimForCompletion(songId, uploadId));
      if (outcome.status === 'NOT_FOUND_SONG')
        throw new AppError(404, 'NOT_FOUND', 'Song not found');
      if (outcome.status === 'NOT_FOUND_UPLOAD')
        throw new AppError(404, 'NOT_FOUND', 'Upload not found');
      if (outcome.status === 'COMPLETE') {
        kind = outcome.kind;
        return outcome.song;
      }
      if (outcome.status === 'UNAVAILABLE') {
        kind = outcome.kind;
        throw new AppError(409, 'UPLOAD_STATE', 'Upload expired, busy, or unavailable');
      }
      const upload = outcome.upload;
      kind = upload.kind;
      let promotionAttempted = false;
      try {
        const info = await measure('r2_head', () => this.storage.head(upload.staging_key));
        if (info.byteSize !== upload.byte_size || info.contentType !== upload.content_type)
          throw new AppError(400, 'ASSET_MISMATCH', 'Uploaded size or content type does not match');
        if (upload.kind === 'package') {
          const json = await measure('package_read', async () => {
            try {
              return JSON.parse(
                utf8Decoder.decode(
                  await this.storage.read(upload.staging_key, limits.package, info),
                ),
              ) as unknown;
            } catch (e) {
              if (e instanceof SyntaxError)
                throw new AppError(400, 'INVALID_PACKAGE', 'Song package must be valid JSON');
              throw e;
            }
          });
          measureSync('package_validation', () => {
            const pkg = parseSongPackage(json);
            if (
              pkg.durationMs !== upload.duration_ms ||
              pkg.packageVersion !== upload.package_version
            )
              throw new AppError(
                400,
                'PACKAGE_MISMATCH',
                'Package duration/version differs from song',
              );
          });
        } else {
          const bytes = await measure('audio_prefix_read', () =>
            this.storage.prefix(upload.staging_key, 64, info.etag),
          );
          measureSync('file_signature_validation', () => {
            if (!isValidMediaSignature(upload.content_type, bytes))
              throw new AppError(400, 'INVALID_FILE', 'File signature does not match content type');
          });
        }
        promotionAttempted = true;
        await measure('r2_promote', () =>
          this.storage.promote(upload.staging_key, upload.final_key, info.etag, info.contentType),
        );
        const completed = await measure('database_commit', () => this.songs.complete(upload));
        // Cleanup failure does not invalidate a committed upload; lifecycle handles leftovers.
        try {
          await measure('staging_cleanup', () => this.storage.remove(upload.staging_key));
        } catch {
          console.warn('Staging cleanup deferred to lifecycle');
        }
        return completed ?? (await measure('song_reload', () => this.get(songId, true)));
      } catch (e) {
        // A lost commit response must not cause deletion of an already-published object.
        const current = await measure('failure_lookup', () => this.songs.getUpload(uploadId));
        if (current?.status === 'COMPLETE')
          return await measure('song_reload', () => this.get(songId, true));
        if (promotionAttempted) {
          try {
            await measure('failed_final_object_cleanup', () =>
              this.storage.remove(upload.final_key),
            );
          } catch {
            throw e;
          } // Keep reservation/PROCESSING for maintenance recovery.
        }
        await measure('failure_reset', () => this.songs.reset(uploadId));
        throw e;
      }
    } finally {
      console.info(
        JSON.stringify({
          event: 'upload_completion_timing',
          assetKind: kind,
          totalWallMs: Number((performance.now() - startedAt).toFixed(2)),
          stages,
        }),
      );
    }
  }
  async publish(id: string) {
    const song = await this.get(id, true);
    if (song.status !== 'DRAFT' || !song.audio_key || !song.package_key)
      throw new AppError(
        409,
        'SONG_INCOMPLETE',
        'A draft needs verified audio and a verified scoring package',
      );
    return this.songs.transition(id, 'PUBLISHED');
  }
  async archive(id: string) {
    await this.get(id, true);
    return this.songs.transition(id, 'ARCHIVED');
  }
  async download(id: string) {
    const s = await this.get(id);
    return {
      songId: s.id,
      packageVersion: s.package_version,
      durationMs: s.duration_ms,
      audioUrl: await this.storage.downloadUrl(s.audio_key!),
      packageUrl: await this.storage.downloadUrl(s.package_key!),
      coverUrl: s.cover_key ? await this.storage.downloadUrl(s.cover_key) : null,
      expiresIn: 900,
    };
  }
}
