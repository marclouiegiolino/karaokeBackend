import type { Song } from '../Song/Song.js';
export interface IFavoriteRepository {
  list(userId: string, page: number, pageSize: number): Promise<Song[]>;
  add(userId: string, songId: string): Promise<void>;
  remove(userId: string, songId: string): Promise<void>;
}
