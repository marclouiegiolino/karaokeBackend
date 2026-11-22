import * as z from 'zod';
import type { FastValidatedSchema } from '../../Middleware/ValidateRequest.js';
export const uploadSongSchema: FastValidatedSchema<{
  kind: 'audio' | 'cover' | 'package';
  contentType: string;
  byteSize: number;
}> = z
  .object({
    kind: z.enum(['audio', 'cover', 'package']),
    contentType: z.string().min(1).max(100),
    byteSize: z.number().int().positive(),
  })
  .strict();
uploadSongSchema._fastParse = (raw: unknown) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const { kind, contentType, byteSize } = obj;
  if (kind !== 'audio' && kind !== 'cover' && kind !== 'package') return undefined;
  if (typeof contentType !== 'string' || contentType.length < 1 || contentType.length > 100) {
    return undefined;
  }
  if (typeof byteSize !== 'number' || !Number.isSafeInteger(byteSize) || byteSize <= 0) {
    return undefined;
  }
  if (Object.keys(obj).length !== 3) return undefined;
  return { kind, contentType, byteSize };
};
export type UploadSongRequest = z.infer<typeof uploadSongSchema>;
