import * as z from 'zod';
const timed = z.object({ startMs: z.number().int().min(0), endMs: z.number().int().positive() });
export const songPackageSchema = z
  .object({
    formatVersion: z.literal(1),
    packageVersion: z.number().int().positive(),
    durationMs: z.number().int().positive(),
    lyrics: z
      .array(timed.extend({ text: z.string().min(1).max(500) }).strict())
      .min(1)
      .max(5000),
    notes: z
      .array(timed.extend({ midiNote: z.number().int().min(0).max(127) }).strict())
      .min(0)
      .max(20000),
  })
  .strict()
  .superRefine((p, ctx) => {
    for (const [name, items] of [
      ['lyrics', p.lyrics],
      ['notes', p.notes],
    ] as const) {
      let previousEnd = 0;
      items.forEach((item, index) => {
        if (item.endMs <= item.startMs || item.endMs > p.durationMs || item.startMs < previousEnd) {
          ctx.addIssue({
            code: 'custom',
            message: 'Intervals must be ordered, non-overlapping, and within song duration',
            path: [name, index],
          });
        }
        previousEnd = item.endMs;
      });
    }
  });
export type SongPackage = z.infer<typeof songPackageSchema>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fastValidatePackage(raw: unknown): SongPackage | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const { formatVersion, packageVersion, durationMs, lyrics, notes } = raw;
  if (
    formatVersion !== 1 ||
    !Number.isSafeInteger(packageVersion) ||
    (packageVersion as number) <= 0 ||
    !Number.isSafeInteger(durationMs) ||
    (durationMs as number) <= 0 ||
    !Array.isArray(lyrics) ||
    lyrics.length < 1 ||
    lyrics.length > 5000 ||
    !Array.isArray(notes) ||
    notes.length > 20000 ||
    Object.keys(raw).length !== 5
  ) {
    return undefined;
  }
  const dur = durationMs as number;
  let prevLyricEnd = 0;
  for (let i = 0; i < lyrics.length; i++) {
    const item = lyrics[i];
    if (!isPlainRecord(item)) return undefined;
    const { startMs, endMs, text } = item;
    if (
      !Number.isSafeInteger(startMs) ||
      !Number.isSafeInteger(endMs) ||
      (startMs as number) < prevLyricEnd ||
      (endMs as number) <= (startMs as number) ||
      (endMs as number) > dur ||
      typeof text !== 'string' ||
      text.length < 1 ||
      text.length > 500 ||
      Object.keys(item).length !== 3
    ) {
      return undefined;
    }
    prevLyricEnd = endMs as number;
  }
  let prevNoteEnd = 0;
  for (let i = 0; i < notes.length; i++) {
    const item = notes[i];
    if (!isPlainRecord(item)) return undefined;
    const { startMs, endMs, midiNote } = item;
    if (
      !Number.isSafeInteger(startMs) ||
      !Number.isSafeInteger(endMs) ||
      (startMs as number) < prevNoteEnd ||
      (endMs as number) <= (startMs as number) ||
      (endMs as number) > dur ||
      !Number.isSafeInteger(midiNote) ||
      (midiNote as number) < 0 ||
      (midiNote as number) > 127 ||
      Object.keys(item).length !== 3
    ) {
      return undefined;
    }
    prevNoteEnd = endMs as number;
  }
  return raw as SongPackage;
}

export function parseSongPackage(raw: unknown): SongPackage {
  return fastValidatePackage(raw) ?? songPackageSchema.parse(raw);
}
