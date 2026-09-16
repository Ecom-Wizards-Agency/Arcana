'use client';
import type { ReversionBatchPreview } from '@wizard-ads/shared';
import { changeQueueHref } from '../../src/screens/optimizer/navigation';

export interface ReversionPanelProps { preview: ReversionBatchPreview; canExport: boolean; }

/** Compatibility island: the Change queue owns restore classification and proposal creation. */
export function ReversionPanel({ preview, canExport }: ReversionPanelProps) {
  return <section aria-label="Restore proposal"><h2>{preview.tag}</h2><p>{preview.readyRows} rows can be reviewed against the current synchronized values.</p><a href={changeQueueHref(preview.profileId, { batch: preview.batchId })}>Review restore proposal</a>{!canExport ? <p>Your role may inspect evidence but cannot approve or export changes.</p> : null}</section>;
}
