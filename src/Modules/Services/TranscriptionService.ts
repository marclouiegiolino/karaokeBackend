import type { AiBinding } from '../../Types/Environment.js';
import type { ISongRepository } from '../Song/ISongRepository.js';
import type { IFileStorage } from './IFileStorage.js';
import { AppError } from '../../Utils/AppError.js';

export const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';
export const MAX_TRANSCRIBE_AUDIO_BYTES = 5_000_000;
export const MAX_TRANSCRIBE_DURATION_MS = 360_000;
export const DEFAULT_TRANSCRIBE_TIMEOUT_MS = 45_000;
const MAX_LINE_CHARS = 500;
const MAX_LYRIC_LINES = 5000;

export type TranscriptLine = {
  text: string;
  startMs: number | null;
  endMs: number | null;
};

export type TranscriptionResult = {
  songId: string;
  model: string;
  language: string | null;
  hasTimestamps: boolean;
  lines: TranscriptLine[];
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function splitLongText(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  if (normalized.length <= MAX_LINE_CHARS) return [normalized];

  const lines: string[] = [];
  let remaining = normalized;
  while (remaining.length > MAX_LINE_CHARS && lines.length < MAX_LYRIC_LINES) {
    let splitAt = remaining.lastIndexOf(' ', MAX_LINE_CHARS);
    if (splitAt <= 0) splitAt = MAX_LINE_CHARS;
    lines.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining && lines.length < MAX_LYRIC_LINES) {
    lines.push(remaining);
  }
  return lines;
}

export function normalizeWhisperOutput(
  raw: unknown,
  songDurationMs: number,
): {
  language: string | null;
  hasTimestamps: boolean;
  lines: TranscriptLine[];
} {
  if (!isPlainRecord(raw)) {
    throw new AppError(
      502,
      'AI_INVALID_RESPONSE',
      'Transcription service returned an invalid response',
    );
  }

  let language: string | null = null;
  if (
    isPlainRecord(raw.transcription_info) &&
    typeof raw.transcription_info.language === 'string'
  ) {
    const trimmed = raw.transcription_info.language.trim();
    if (trimmed) language = trimmed.slice(0, 32);
  }

  if (raw.segments !== undefined && !Array.isArray(raw.segments)) {
    throw new AppError(502, 'AI_INVALID_RESPONSE', 'Transcription segments had an invalid format');
  }

  const rawSegments = Array.isArray(raw.segments) ? raw.segments : [];
  if (rawSegments.length > 0) {
    const segmentLines: { text: string; startMs: number | null; endMs: number | null }[] = [];
    let allTimestampsValid = true;
    let prevEndMs = 0;

    for (const seg of rawSegments) {
      if (!isPlainRecord(seg)) {
        throw new AppError(502, 'AI_INVALID_RESPONSE', 'Transcription segment was malformed');
      }
      if (typeof seg.text !== 'string') continue;
      const text = seg.text.replace(/\s+/g, ' ').trim();
      if (!text) continue;

      if (text.length > MAX_LINE_CHARS) {
        allTimestampsValid = false;
      }

      const startSec = seg.start;
      const endSec = seg.end;
      if (
        allTimestampsValid &&
        typeof startSec === 'number' &&
        typeof endSec === 'number' &&
        Number.isFinite(startSec) &&
        Number.isFinite(endSec)
      ) {
        const startMs = Math.round(startSec * 1000);
        const endMs = Math.round(endSec * 1000);
        if (
          Number.isSafeInteger(startMs) &&
          Number.isSafeInteger(endMs) &&
          startMs >= prevEndMs &&
          endMs > startMs &&
          endMs <= songDurationMs
        ) {
          prevEndMs = endMs;
          segmentLines.push({ text, startMs, endMs });
          continue;
        }
      }

      allTimestampsValid = false;
      for (const chunk of splitLongText(text)) {
        if (segmentLines.length >= MAX_LYRIC_LINES) break;
        segmentLines.push({ text: chunk, startMs: null, endMs: null });
      }
      if (segmentLines.length >= MAX_LYRIC_LINES) break;
    }

    if (segmentLines.length > 0) {
      const lines = allTimestampsValid
        ? segmentLines.slice(0, MAX_LYRIC_LINES)
        : segmentLines.slice(0, MAX_LYRIC_LINES).map((line) => ({
            text: line.text,
            startMs: null,
            endMs: null,
          }));
      return {
        language,
        hasTimestamps: allTimestampsValid,
        lines,
      };
    }
  }

  if (typeof raw.text === 'string') {
    const rawLines = raw.text.split(/\r?\n/);
    const lines: TranscriptLine[] = [];
    for (const rawLine of rawLines) {
      for (const chunk of splitLongText(rawLine)) {
        if (lines.length >= MAX_LYRIC_LINES) break;
        lines.push({ text: chunk, startMs: null, endMs: null });
      }
      if (lines.length >= MAX_LYRIC_LINES) break;
    }
    if (lines.length > 0) {
      return {
        language,
        hasTimestamps: false,
        lines,
      };
    }
  } else if (raw.text !== undefined) {
    throw new AppError(502, 'AI_INVALID_RESPONSE', 'Transcription text had an invalid format');
  }

  throw new AppError(422, 'NO_LYRICS_DETECTED', 'No sung lyrics were detected in this audio');
}

function mapProviderError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  const obj = isPlainRecord(error) ? error : {};
  const status = typeof obj.status === 'number' ? obj.status : undefined;
  const name = typeof obj.name === 'string' ? obj.name : '';
  const message =
    error instanceof Error
      ? error.message
      : typeof obj.message === 'string'
        ? obj.message
        : String(error ?? '');

  if (
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    /\btimed?\s*out\b|timeout/i.test(message)
  ) {
    return new AppError(
      504,
      'AI_TIMEOUT',
      'Audio transcription timed out. Try a shorter clip or enter lyrics manually.',
    );
  }
  if (
    status === 429 ||
    /quota|neuron|rate\s*limit|too\s*many\s*requests|limit\s*exceeded/i.test(message)
  ) {
    return new AppError(
      429,
      'AI_QUOTA_EXCEEDED',
      'Workers AI transcription quota or rate limit was reached. Try again later or enter lyrics manually.',
    );
  }
  if (status === 400 || status === 413 || status === 422) {
    return new AppError(
      422,
      'AI_UNSUPPORTED_AUDIO',
      'Workers AI could not transcribe this audio format or length.',
    );
  }
  if (
    (status !== undefined && status >= 500) ||
    /unavailable|overloaded|service\s*error|internal\s*error/i.test(message)
  ) {
    return new AppError(
      503,
      'AI_UNAVAILABLE',
      'Workers AI transcription service is temporarily unavailable. Please retry shortly.',
    );
  }
  return new AppError(502, 'AI_PROVIDER_ERROR', 'Audio transcription failed at the AI provider.');
}

async function runWithTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const timeoutErr = new Error('Workers AI request timed out');
          timeoutErr.name = 'TimeoutError';
          reject(timeoutErr);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class TranscriptionService {
  constructor(
    private songs: ISongRepository,
    private storage: IFileStorage,
    private ai?: AiBinding,
    private timeoutMs = DEFAULT_TRANSCRIBE_TIMEOUT_MS,
  ) {}

  async transcribeSong(
    songId: string,
    options: { language?: string } = {},
  ): Promise<TranscriptionResult> {
    if (!this.ai) {
      throw new AppError(
        503,
        'AI_UNCONFIGURED',
        'Workers AI binding (AI) is not configured in this environment.',
      );
    }

    const song = await this.songs.findById(songId);
    if (!song) {
      throw new AppError(404, 'NOT_FOUND', 'Song not found');
    }
    if (song.status === 'ARCHIVED') {
      throw new AppError(409, 'SONG_ARCHIVED', 'Archived songs cannot be transcribed');
    }
    if (!song.audio_key) {
      throw new AppError(
        409,
        'AUDIO_REQUIRED',
        'Upload verified audio for this song before generating lyrics',
      );
    }
    if (song.duration_ms > MAX_TRANSCRIBE_DURATION_MS) {
      throw new AppError(
        400,
        'TRANSCRIPTION_AUDIO_TOO_LONG',
        'Automatic transcription is limited to tracks up to 6 minutes.',
      );
    }

    const info = await this.storage.head(song.audio_key);
    if (info.byteSize < 1) {
      throw new AppError(400, 'INVALID_ASSET', 'Uploaded song audio is empty');
    }
    if (info.byteSize > MAX_TRANSCRIBE_AUDIO_BYTES) {
      throw new AppError(
        400,
        'TRANSCRIPTION_AUDIO_TOO_LARGE',
        'Automatic transcription is limited to audio files up to 5 MB.',
      );
    }

    const bytes = await this.storage.read(song.audio_key, MAX_TRANSCRIBE_AUDIO_BYTES, info);
    // Single bounded native base64 conversion without decoding, resampling, or JS chunking.
    const audioBase64 = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
      'base64',
    );

    const payload: Record<string, unknown> = {
      audio: audioBase64,
      task: 'transcribe',
      vad_filter: true,
    };
    const requestedLang = options.language ?? song.language ?? undefined;
    if (requestedLang && /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(requestedLang)) {
      payload.language = requestedLang;
    }

    let rawOutput: unknown;
    try {
      rawOutput = await runWithTimeout(this.ai.run(WHISPER_MODEL, payload), this.timeoutMs);
    } catch (error) {
      throw mapProviderError(error);
    }

    const normalized = normalizeWhisperOutput(rawOutput, song.duration_ms);
    return {
      songId: song.id,
      model: WHISPER_MODEL,
      language: normalized.language,
      hasTimestamps: normalized.hasTimestamps,
      lines: normalized.lines,
    };
  }
}
