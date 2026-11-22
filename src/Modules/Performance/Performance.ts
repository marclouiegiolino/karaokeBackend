export interface Performance {
  id: string;
  user_id: string;
  song_id: string;
  package_version: number;
  scoring_version: string;
  pitch: number;
  timing: number;
  coverage: number;
  total: number;
  key_shift: number;
  tempo: number;
  started_at: number;
  finished_at: number;
  payload_hash: string;
  created_at: number;
}
export function performanceResponse(p: Performance) {
  const { payload_hash, ...result } = p;
  return { ...result, verification: 'device-reported' };
}
