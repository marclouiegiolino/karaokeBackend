export interface Song {
  id: string;
  title: string;
  artist: string;
  genre: string | null;
  language: string | null;
  duration_ms: number;
  package_version: number;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  audio_key: string | null;
  cover_key: string | null;
  package_key: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}
export function songResponse(song: Song) {
  const { audio_key, cover_key, package_key, ...metadata } = song;
  return {
    ...metadata,
    hasAudio: !!audio_key,
    hasCover: !!cover_key,
    scoringAvailable: !!package_key,
  };
}
