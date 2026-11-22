import { PlaylistRepository } from '../Playlist/PlaylistRepository.js';
import { SongService } from './SongService.js';
import { AppError } from '../../Utils/AppError.js';
export class PlaylistService {
  constructor(
    readonly repository: PlaylistRepository,
    private songs: SongService,
  ) {}
  async owned(id: string, userId: string) {
    const p = await this.repository.findById(id);
    if (!p || p.user_id !== userId) throw new AppError(404, 'NOT_FOUND', 'Playlist not found');
    return p;
  }
  async addSong(id: string, songId: string, userId: string) {
    await this.owned(id, userId);
    await this.songs.get(songId);
    try {
      await this.repository.addSong(id, songId);
    } catch (e) {
      if (String(e).includes('PLAYLIST_FULL'))
        throw new AppError(409, 'PLAYLIST_FULL', 'A playlist can contain at most 500 songs');
      throw e;
    }
  }
}
