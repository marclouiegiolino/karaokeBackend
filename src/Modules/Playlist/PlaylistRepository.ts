import { BaseRepository } from '../../Main/BaseRepository.js';
import type { Playlist } from './Playlist.js';
import type { Song } from '../Song/Song.js';
import type { IPlaylistRepository } from './IPlaylistRepository.js';
import type { CreatePlaylistRequest } from '../../DTOs/Playlist/CreatePlaylistRequest.js';
export class PlaylistRepository extends BaseRepository implements IPlaylistRepository {
  findById(id: string) {
    return this.first<Playlist>('SELECT * FROM playlists WHERE id=?', [id]);
  }
  list(userId: string, page: number, pageSize: number) {
    return this.rows<Playlist>(
      'SELECT * FROM playlists WHERE user_id=? ORDER BY updated_at DESC,id LIMIT ? OFFSET ?',
      [userId, pageSize, (page - 1) * pageSize],
    );
  }
  async create(userId: string, input: CreatePlaylistRequest) {
    const id = crypto.randomUUID(),
      now = Date.now();
    await this.db.execute({
      sql: 'INSERT INTO playlists(id,user_id,name,description,created_at,updated_at) VALUES(?,?,?,?,?,?)',
      args: [id, userId, input.name, input.description, now, now],
    });
    return (await this.findById(id))!;
  }
  songs(id: string) {
    return this.rows<Song & { position: number }>(
      "SELECT s.*,ps.position FROM playlist_songs ps JOIN songs s ON s.id=ps.song_id WHERE ps.playlist_id=? AND s.status='PUBLISHED' ORDER BY ps.position",
      [id],
    );
  }
  async update(id: string, input: { name?: string; description?: string }) {
    await this.db.execute({
      sql: 'UPDATE playlists SET name=COALESCE(?,name),description=COALESCE(?,description),updated_at=? WHERE id=?',
      args: [input.name ?? null, input.description ?? null, Date.now(), id],
    });
    return this.findById(id);
  }
  async remove(id: string) {
    await this.db.execute({ sql: 'DELETE FROM playlists WHERE id=?', args: [id] });
  }
  async addSong(id: string, songId: string) {
    const tx = await this.db.transaction('write');
    try {
      const count = await tx.execute({
        sql: 'SELECT COUNT(*) AS n FROM playlist_songs WHERE playlist_id=?',
        args: [id],
      });
      if (Number(count.rows[0]?.n ?? 0) >= 500) throw new Error('PLAYLIST_FULL');
      await tx.execute({
        sql: 'INSERT OR IGNORE INTO playlist_songs(playlist_id,song_id,position,added_at) SELECT ?,?,COALESCE(MAX(position),0)+1,? FROM playlist_songs WHERE playlist_id=?',
        args: [id, songId, Date.now(), id],
      });
      await tx.execute({
        sql: 'UPDATE playlists SET updated_at=? WHERE id=?',
        args: [Date.now(), id],
      });
      await tx.commit();
    } finally {
      tx.close();
    }
  }
  async removeSong(id: string, songId: string) {
    await this.db.execute({
      sql: 'DELETE FROM playlist_songs WHERE playlist_id=? AND song_id=?',
      args: [id, songId],
    });
  }
}
