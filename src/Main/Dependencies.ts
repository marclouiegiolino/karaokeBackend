import type { Database } from './Database.js';
import type { Configuration } from './Configuration.js';
import type { IFileStorage } from '../Modules/Services/IFileStorage.js';
import type { AiBinding, RateLimitBinding } from '../Types/Environment.js';
import { UserRepository } from '../Modules/User/UserRepository.js';
import { SongRepository } from '../Modules/Song/SongRepository.js';
import { PlaylistRepository } from '../Modules/Playlist/PlaylistRepository.js';
import { FavoriteRepository } from '../Modules/Favorite/FavoriteRepository.js';
import { PerformanceRepository } from '../Modules/Performance/PerformanceRepository.js';
import { SessionRepository } from '../Security/SessionRepository.js';
import { PasswordHasher } from '../Security/PasswordHasher.js';
import { SessionService } from '../Security/SessionService.js';
import { AuthenticationService } from '../Modules/Services/AuthenticationService.js';
import { SongService } from '../Modules/Services/SongService.js';
import { PlaylistService } from '../Modules/Services/PlaylistService.js';
import { PerformanceSyncService } from '../Modules/Services/PerformanceSyncService.js';
import { TranscriptionService } from '../Modules/Services/TranscriptionService.js';
export function buildDependencies(
  config: Configuration,
  db: Database,
  storage: IFileStorage,
  limiters?: { api: RateLimitBinding; auth: RateLimitBinding; ai?: RateLimitBinding },
  runtime: 'node' | 'worker' = 'node',
  ai?: AiBinding,
) {
  const users = new UserRepository(db),
    songs = new SongRepository(db),
    playlists = new PlaylistRepository(db),
    favorites = new FavoriteRepository(db),
    performances = new PerformanceRepository(db),
    sessionRepository = new SessionRepository(db),
    passwords = new PasswordHasher(config.PASSWORD_PEPPER);
  const sessions = new SessionService(sessionRepository, config),
    songService = new SongService(songs, storage);
  return {
    config,
    db,
    storage,
    limiters,
    runtime,
    ai,
    users,
    songs,
    playlists,
    favorites,
    performances,
    passwords,
    sessions,
    auth: new AuthenticationService(users, passwords, sessions),
    songService,
    playlistService: new PlaylistService(playlists, songService),
    performanceSync: new PerformanceSyncService(performances, songs),
    transcription: new TranscriptionService(songs, storage, ai),
  };
}
export type Dependencies = ReturnType<typeof buildDependencies>;
