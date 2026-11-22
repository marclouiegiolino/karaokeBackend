import type { Song } from './Song.js';
export interface ISongRepository {
  findById(id: string): Promise<Song | undefined>;
  list(page: number, pageSize: number, search: string, includeDrafts: boolean): Promise<Song[]>;
}
