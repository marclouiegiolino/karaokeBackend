import { BaseRepository } from '../../Main/BaseRepository.js';
import type { Performance } from './Performance.js';
import type { IPerformanceRepository } from './IPerformanceRepository.js';
export class PerformanceRepository extends BaseRepository implements IPerformanceRepository {
  findById(id: string) {
    return this.first<Performance>('SELECT * FROM performances WHERE id=?', [id]);
  }
  async insert(p: Performance) {
    const result = await this.db.execute({
      sql: 'INSERT INTO performances(id,user_id,song_id,package_version,scoring_version,pitch,timing,coverage,total,key_shift,tempo,started_at,finished_at,payload_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
      args: [
        p.id,
        p.user_id,
        p.song_id,
        p.package_version,
        p.scoring_version,
        p.pitch,
        p.timing,
        p.coverage,
        p.total,
        p.key_shift,
        p.tempo,
        p.started_at,
        p.finished_at,
        p.payload_hash,
        p.created_at,
      ],
    });
    return result.rowsAffected > 0;
  }
  list(userId: string, page: number, pageSize: number) {
    return this.rows<Performance>(
      'SELECT * FROM performances WHERE user_id=? ORDER BY finished_at DESC,id LIMIT ? OFFSET ?',
      [userId, pageSize, (page - 1) * pageSize],
    );
  }
}
