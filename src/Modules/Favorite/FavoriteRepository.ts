import { BaseRepository } from '../../Main/BaseRepository.js';
import type { Song } from '../Song/Song.js';
import type { IFavoriteRepository } from './IFavoriteRepository.js';
export class FavoriteRepository extends BaseRepository implements IFavoriteRepository {
  list(userId: string, page: number, pageSize: number) {
    return this.rows<Song>(
      "SELECT s.* FROM favorites f JOIN songs s ON s.id=f.song_id WHERE f.user_id=? AND s.status='PUBLISHED' ORDER BY f.created_at DESC,s.id LIMIT ? OFFSET ?",
      [userId, pageSize, (page - 1) * pageSize],
    );
  }
  async add(userId: string, songId: string) {
    await this.db.execute({
      sql: 'INSERT OR IGNORE INTO favorites(user_id,song_id,created_at) VALUES(?,?,?)',
      args: [userId, songId, Date.now()],
    });
  }
  async remove(userId: string, songId: string) {
    await this.db.execute({
      sql: 'DELETE FROM favorites WHERE user_id=? AND song_id=?',
      args: [userId, songId],
    });
  }
}
