import { z } from 'zod';
import { JobType } from './jobs.js';

export const IngestionLane = z.enum([
  'vercel-default', 'vercel-reduced', 'evo-report', 'evo-report-unified',
  'integrations', 'evo-recommendation',
]);
export type IngestionLane = z.infer<typeof IngestionLane>;

/** Deployment and accounting metadata, independent of worker implementations. */
export const IngestionSource = z.object({
  jobType: JobType,
  reportType: z.string().min(1).optional(),
  source: z.string().min(1),
  laneAffinity: z.array(IngestionLane),
  counts: z.array(z.string().min(1)).min(1),
});
export type IngestionSource = z.infer<typeof IngestionSource>;

/** Aggregation may change row grain; loaded rows have a separate verification. */
export const IngestionCounts = z.object({
  sourceRows: z.number().int().nonnegative(),
  parsedRows: z.number().int().nonnegative(),
  refusedRows: z.number().int().nonnegative(),
  loadedRows: z.number().int().nonnegative(),
  verifiedLoadedRows: z.number().int().nonnegative(),
}).superRefine((counts, context) => {
  if (counts.sourceRows !== counts.parsedRows + counts.refusedRows) {
    context.addIssue({ code: 'custom', message: 'ingestion source counts do not reconcile' });
  }
  if (counts.loadedRows !== counts.verifiedLoadedRows) {
    context.addIssue({ code: 'custom', message: 'ingestion loaded counts do not reconcile' });
  }
});
export type IngestionCounts = z.infer<typeof IngestionCounts>;
