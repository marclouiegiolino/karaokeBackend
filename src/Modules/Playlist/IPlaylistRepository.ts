import type { Playlist } from './Playlist.js';
export interface IPlaylistRepository {
  findById(id: string): Promise<Playlist | undefined>;
  list(userId: string, page: number, pageSize: number): Promise<Playlist[]>;
}
