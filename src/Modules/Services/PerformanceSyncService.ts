import { digest } from '../../Security/TokenService.js';
import type { IPerformanceRepository } from '../Performance/IPerformanceRepository.js';
import type { ISongRepository } from '../Song/ISongRepository.js';
import type { SyncPerformanceRequest } from '../../DTOs/Performance/SyncPerformanceRequest.js';
import { performanceResponse } from '../Performance/Performance.js';
import { AppError } from '../../Utils/AppError.js';
export class PerformanceSyncService {
  constructor(
    private repository: IPerformanceRepository,
    private songs: ISongRepository,
  ) {}
  async sync(input: SyncPerformanceRequest, userId: string) {
    // Fixed field order: hash is insensitive to HTTP JSON property order.
    const values = [
      input.id,
      input.songId,
      input.packageVersion,
      input.scoringVersion,
      input.pitch,
      input.timing,
      input.coverage,
      input.keyShift,
      input.tempo,
      input.startedAt,
      input.finishedAt,
    ];
    const hash = digest(JSON.stringify(values));
    const existing = await this.repository.findById(input.id);
    if (existing) {
      if (existing.user_id !== userId || existing.payload_hash !== hash)
        throw new AppError(409, 'SYNC_CONFLICT', 'Performance ID has already been used');
      return { created: false, performance: performanceResponse(existing) };
    }
    if (input.finishedAt > Date.now() + 300000)
      throw new AppError(400, 'FUTURE_RESULT', 'Performance ends in the future');
    const song = await this.songs.findById(input.songId);
    // Archived songs remain valid for results from previously downloaded packages.
    if (!song || song.status === 'DRAFT' || song.package_version !== input.packageVersion)
      throw new AppError(409, 'PACKAGE_UNAVAILABLE', 'Song package version is unavailable');
    const p = {
      id: input.id,
      user_id: userId,
      song_id: input.songId,
      package_version: input.packageVersion,
      scoring_version: input.scoringVersion,
      pitch: input.pitch,
      timing: input.timing,
      coverage: input.coverage,
      total: Math.round(input.pitch * 0.6 + input.timing * 0.25 + input.coverage * 0.15),
      key_shift: input.keyShift,
      tempo: input.tempo,
      started_at: input.startedAt,
      finished_at: input.finishedAt,
      payload_hash: hash,
      created_at: Date.now(),
    };
    const created = await this.repository.insert(p);
    if (!created) {
      const saved = (await this.repository.findById(p.id))!;
      if (saved.user_id !== userId || saved.payload_hash !== hash)
        throw new AppError(409, 'SYNC_CONFLICT', 'Performance ID has already been used');
      return { created: false, performance: performanceResponse(saved) };
    }
    return { created: true, performance: performanceResponse(p) };
  }
}
