import { z } from 'zod';
import { AmazonObservation } from './ads-catalogue.js';
import { ApplyValue } from './apply.js';
import { ReversionBatchPreview, ReversionRowPreview } from './optimization.js';

export const COORDINATED_RESTORE_UNAVAILABLE = 'Restore not available for coordinated changes. These controls belong to one dependency set and cannot be restored independently.';

/** Exported proposals count dependency sets; restore counts always count physical rows. */
export const ChangeQueueRestoreBatchPreview = z.object({
  ...ReversionBatchPreview.shape,
  dependencySetCount: z.number().int().positive().nullable(),
}).superRefine((batch, context) => {
  const totalRows = batch.reversibleRows + batch.unsupportedRows;
  if (batch.exportedProposals !== (batch.dependencySetCount ?? totalRows)
    || batch.rows.length !== batch.reversibleRows
    || batch.readyRows + batch.blockedRows !== totalRows
    || batch.readyRows !== batch.rows.filter(row => row.exportAllowed).length
    || (batch.dependencySetCount !== null && (batch.dependencySetCount > batch.reversibleRows
      || batch.readyRows !== 0 || batch.exportAllowed))) {
    context.addIssue({ code: 'custom', message: 'Restore row counts or dependency-set eligibility disagree' });
  }
});
export type ChangeQueueRestoreBatchPreview = z.infer<typeof ChangeQueueRestoreBatchPreview>;

export const ChangeQueueSource = z.enum(['apply', 'sync', 'amazon', 'queued', 'restore', 'campaign_creation', 'campaign_creation_retry']);
export type ChangeQueueSource = z.infer<typeof ChangeQueueSource>;
export const ChangeQueueState = z.enum(['confirmed', 'exported', 'observed', 'unattributed', 'awaiting review', 'approved', 'acknowledged', 'requested', 'admitted', 'attempted', 'succeeded', 'failed', 'partial_failed', 'awaiting_observation', 'refused', 'blocked', 'needs_attention']);
export type ChangeQueueState = z.infer<typeof ChangeQueueState>;
/** Who made a change: an operator, Arcana automation, a console user at Amazon, or nobody Arcana can name. */
export const ChangeQueueActorKind = z.enum(['operator', 'automation', 'ads_console', 'unknown']);
export type ChangeQueueActorKind = z.infer<typeof ChangeQueueActorKind>;
/** The name is the member identity the reader may see; null when it is unknown or not readable to them. */
export const ChangeQueueActor = z.object({ kind: ChangeQueueActorKind, name: z.string().min(1).nullable() }).strict();
export type ChangeQueueActor = z.infer<typeof ChangeQueueActor>;
export const ChangeQueueEntry = z.object({
  amazonObservation: AmazonObservation.nullable().optional(),
  actor: ChangeQueueActor,
  id: z.string(), when: z.string(), entity: z.string(), entityType: z.string(), entityId: z.string(),
  field: z.string(), oldValue: z.unknown(), newValue: z.unknown(), source: ChangeQueueSource, state: ChangeQueueState,
  batchId: z.uuid().nullable(), batchLabel: z.string().nullable(), batchCount: z.number().int().nonnegative().nullable(),
  experimentStart: z.boolean(), candidateCount: z.number().int().nonnegative(),
  /**
   * Whether every row of the row's batch has a recorded before-value, so its restore preview can
   * open. Null when the row names no exported batch it could restore.
   */
  batchRestorable: z.boolean().nullable(),
  acknowledgedAt: z.string().nullable(), acknowledgedBy: z.uuid().nullable(), reviewHref: z.string().nullable(),
 }).strict().superRefine((row,context)=>{
  if(row.source==='amazon' && (!row.amazonObservation || row.batchId!==null || row.reviewHref!==null || row.acknowledgedBy!==null || row.acknowledgedAt!==null || row.state!=='observed')) {
    context.addIssue({code:'custom',message:'Amazon observations have provenance and no local approval or restore authority'});
  }
  if(row.actor.name!==null && row.actor.kind!=='operator') {
    context.addIssue({code:'custom',message:'Only an operator carries a member name'});
  }
  if(row.batchRestorable!==null && row.batchId===null) {
    context.addIssue({code:'custom',message:'Only a row with a batch can say whether the batch is restorable'});
  }
  const expected=row.source==='amazon'?'unknown':row.source==='sync'?'ads_console':null;
  if(expected!==null && row.actor.kind!==expected) {
    context.addIssue({code:'custom',message:'Observed changes name no Arcana actor'});
  }
});

export type ChangeQueueEntry = z.infer<typeof ChangeQueueEntry>;
export const RestorePreviewState = z.enum(['ready', 'conflict', 'already restored', 'unsupported', 'awaiting sync', 'ambiguous']);
export type RestorePreviewState = z.infer<typeof RestorePreviewState>;
export const RestorePreviewRow = z.object({
  rowId: z.uuid(), entityId: z.string(), entityType: z.string(), entity: z.string(), field: z.string(),
  weSet: ApplyValue, now: ApplyValue, restoreTo: ApplyValue, state: RestorePreviewState, why: z.string(),
  readAt: z.string().nullable(),
}).strict();
export type RestorePreviewRow = z.infer<typeof RestorePreviewRow>;
export const RestorePreviewInput = z.object({ exportedAt: z.string(), row: ReversionRowPreview }).strict();
export type RestorePreviewInput = z.infer<typeof RestorePreviewInput>;

export const RestoreProposalRequest = z.object({requestId:z.uuid(),profileId:z.uuid(),applyBatchId:z.uuid(),
  sourceRowIds:z.array(z.uuid()).min(1).max(500).refine(rows=>new Set(rows).size===rows.length)}).strict();
export type RestoreProposalRequest = z.infer<typeof RestoreProposalRequest>;
