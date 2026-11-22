import * as z from 'zod';
export const syncPerformanceSchema = z
  .object({
    id: z.uuid(),
    songId: z.uuid(),
    packageVersion: z.number().int().positive(),
    scoringVersion: z.literal('1.0.0'),
    pitch: z.number().min(0).max(100),
    timing: z.number().min(0).max(100),
    coverage: z.number().min(0).max(100),
    keyShift: z.number().int().min(-12).max(12),
    tempo: z.number().min(0.5).max(1.5),
    startedAt: z.number().int().min(0),
    finishedAt: z.number().int().min(0),
  })
  .strict()
  .refine(
    (v) => v.finishedAt > v.startedAt && v.finishedAt - v.startedAt <= 86400000,
    'Invalid performance time interval',
  );
export type SyncPerformanceRequest = z.infer<typeof syncPerformanceSchema>;
