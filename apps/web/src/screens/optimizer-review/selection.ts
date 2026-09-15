import type { RecommendationRecord } from '@wizard-ads/db';
import { OptimizerSelectionExportResult } from '@wizard-ads/shared';
import { reviewUnits, selectedIncludesShadow } from './model';

type Post = (url: string, body: unknown) => Promise<unknown>;
async function post(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) });
  const value: unknown = await response.json();
  if (!response.ok) throw new Error(typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string' ? value.error : 'The saved selection changed. Refresh this review.');
  return value;
}

/** Selection records decisions only. Export and immutable approval remain separate acts. */
export async function acceptSelection(rows: readonly RecommendationRecord[], selected: ReadonlySet<string>, send: Post = post): Promise<string[]> {
  const units = reviewUnits(rows);
  const selectedRows = rows.filter((row) => selected.has(row.id));
  if (!selectedRows.length || selectedRows.length !== selected.size || selectedIncludesShadow(units, selected)
    || units.some((unit) => unit.rows.some((row) => selected.has(row.id)) && (!unit.selectable || !unit.rows.every((row) => selected.has(row.id))))) throw new Error('Choose complete, executable suggestion sets before continuing.');
  const reopen = rows.filter((row) => row.status === 'accepted' && !selected.has(row.id)).map((row) => row.id);
  if (reopen.length) await decide(reopen, 'proposed', send);
  const accept = selectedRows.filter((row) => row.status !== 'accepted').map((row) => row.id);
  if (accept.length) await decide(accept, 'accepted', send);
  return selectedRows.map((row) => row.id);
}
async function decide(ids: string[], decision: 'accepted' | 'proposed', send: Post) {
  const result = await send('/api/recommendations/decide', { ids, decision, note: 'Optimize Now selection' });
  if (typeof result !== 'object' || result === null || !('updated' in result) || result.updated !== ids.length
    || !('offered' in result) || result.offered !== ids.length || !('refused' in result) || !Array.isArray(result.refused) || result.refused.length > 0) throw new Error('The recorded selection does not match the selected rows. Refresh this review.');
}

export async function stageSelection(profileId: string, rows: readonly RecommendationRecord[], ids: readonly string[], send: Post = post,
  saved?: { batchId: string; reviewFingerprint: string; requestId: string }): Promise<string> {
  const selection = rows.filter((row) => ids.includes(row.id));
  if (saved) {
    if (selection.length !== ids.length || new Set(ids).size !== ids.length || selection.some((row) => row.status === 'dismissed')) throw new Error('The exact selected suggestions are required.');
    const result = OptimizerSelectionExportResult.parse(await send('/api/optimizer/exports', { ...saved, profileId, recommendationIds: [...ids].sort() }));
    if (result.requestId !== saved.requestId || result.batchId !== saved.batchId || result.counts.exported !== ids.length) throw new Error('The staged change count does not match this selection.');
    return result.applyBatchId;
  }
  const runIds = new Set(selection.map((row) => row.runId));
  if (runIds.size !== 1) throw new Error('Changes from several group runs require a combined guarded preview. Review one group run at a time.');
  const result = await send('/api/recommendations/export', { profileId, runId: selection[0]!.runId, ids, note: 'Selected in Optimize Now for guarded preview', optGroup: 'optimizer', lever: 'bid' });
  if (typeof result !== 'object' || result === null || !('batchId' in result) || typeof result.batchId !== 'string'
    || !('exported' in result) || result.exported !== ids.length || !('skipped' in result) || !Array.isArray(result.skipped) || result.skipped.length !== 0) throw new Error('The staged change count does not match this selection.');
  return result.batchId;
}
