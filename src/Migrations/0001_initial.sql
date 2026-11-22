CREATE TABLE users (
 id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
 email TEXT NOT NULL COLLATE NOCASE UNIQUE, display_name TEXT NOT NULL,
 password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'USER' CHECK(role IN ('USER','ADMIN')),
 is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)), created_at INTEGER NOT NULL
);
CREATE TABLE sessions (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
CREATE TABLE songs (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT NOT NULL, genre TEXT, language TEXT,
 duration_ms INTEGER NOT NULL CHECK(duration_ms BETWEEN 1000 AND 1800000),
 package_version INTEGER NOT NULL DEFAULT 1 CHECK(package_version > 0),
 status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','PUBLISHED','ARCHIVED')),
 audio_key TEXT, cover_key TEXT, package_key TEXT,
 created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX songs_status_title_idx ON songs(status,title,id);
CREATE TABLE playlists (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX playlists_owner_idx ON playlists(user_id,updated_at);
CREATE TABLE playlist_songs (
 playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
 song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
 position INTEGER NOT NULL CHECK(position > 0), added_at INTEGER NOT NULL,
 PRIMARY KEY(playlist_id,song_id), UNIQUE(playlist_id,position)
);
CREATE INDEX playlist_songs_song_idx ON playlist_songs(song_id);
CREATE TABLE favorites (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE, created_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,song_id)
);
CREATE INDEX favorites_song_idx ON favorites(song_id);
CREATE TABLE performances (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 song_id TEXT NOT NULL REFERENCES songs(id), package_version INTEGER NOT NULL,
 scoring_version TEXT NOT NULL, pitch REAL NOT NULL CHECK(pitch BETWEEN 0 AND 100),
 timing REAL NOT NULL CHECK(timing BETWEEN 0 AND 100), coverage REAL NOT NULL CHECK(coverage BETWEEN 0 AND 100),
 total INTEGER NOT NULL CHECK(total BETWEEN 0 AND 100), key_shift INTEGER NOT NULL,
 tempo REAL NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL,
 payload_hash TEXT NOT NULL, created_at INTEGER NOT NULL, CHECK(finished_at > started_at)
);
CREATE INDEX performances_owner_history_idx ON performances(user_id,finished_at DESC);
-- This is an application upload budget, NOT a Cloudflare billing hard cap.
CREATE TABLE storage_budget (
 id INTEGER PRIMARY KEY CHECK(id=1), used_bytes INTEGER NOT NULL DEFAULT 0 CHECK(used_bytes>=0),
 reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_bytes>=0),
 limit_bytes INTEGER NOT NULL DEFAULT 2000000000 CHECK(limit_bytes>0)
);
INSERT INTO storage_budget(id) VALUES(1);
CREATE TABLE uploads (
 id TEXT PRIMARY KEY, song_id TEXT NOT NULL REFERENCES songs(id),
 kind TEXT NOT NULL CHECK(kind IN ('audio','cover','package')),
 staging_key TEXT NOT NULL UNIQUE, final_key TEXT NOT NULL UNIQUE,
 content_type TEXT NOT NULL, byte_size INTEGER NOT NULL CHECK(byte_size>0),
 status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','COMPLETE','EXPIRED')),
 expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
 UNIQUE(song_id,kind)
);
CREATE INDEX uploads_expiry_idx ON uploads(status,expires_at);
