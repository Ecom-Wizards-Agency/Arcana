/**
 * How precisely an observed change is dated. Creative history, timeline events,
 * SP-API listing reports and own-collector listing changes all share it.
 *
 * Kept as a leaf module: `timeline-events.ts` is imported by every operator route,
 * and importing it from `creative.ts` would drag the campaign-creation contracts
 * into each of those route graphs.
 */
import { z } from 'zod';

const count = z.number().int().nonnegative();

export const CreativeChangeCertainty = z.object({
  kind: z.enum(['exact', 'window', 'first']),
  from: z.iso.datetime().nullable(), to: z.iso.datetime(), widthDays: count.nullable(),
}).superRefine((value, context) => {
  if (value.from !== null && value.from > value.to) context.addIssue({ code: 'custom', message: 'Observation order is reversed' });
  if (value.kind === 'exact' && (value.from === null || value.widthDays === null || value.widthDays > 1))
    context.addIssue({ code: 'custom', message: 'Exact certainty needs consecutive daily observations' });
  if (value.kind === 'first' && (value.from !== null || value.widthDays !== null))
    context.addIssue({ code: 'custom', message: 'First observation has no earlier boundary' });
});
export type CreativeChangeCertainty = z.infer<typeof CreativeChangeCertainty>;
