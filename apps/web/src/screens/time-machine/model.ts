import type { ChangeQueueEntry, ChangeQueueSource } from '@wizard-ads/shared';
import { buildGridModel, ZERO_TOTALS, type GridColumn } from '@wizard-ads/ui';
/** Where each change came from, in the words every row and the source filter use. */
export const SOURCE_LABEL = { apply: 'Arcana', sync: 'Ads console', amazon: 'Other', queued: 'Arcana', restore: 'Arcana',
  campaign_creation: 'Arcana', campaign_creation_retry: 'Arcana' } as const satisfies Record<ChangeQueueSource,string>;
/** The kind of record behind a source, shown next to the source word. */
export const SOURCE_DETAIL = { apply: 'Batch', sync: null, amazon: 'Provider history', queued: 'Queued proposal', restore: 'Restore',
  campaign_creation: 'Campaign creation', campaign_creation_retry: 'Campaign creation retry' } as const satisfies Record<ChangeQueueSource,string | null>;
export function sourceWords(source: ChangeQueueSource): string {
  const detail = SOURCE_DETAIL[source];
  return detail === null ? SOURCE_LABEL[source] : `${SOURCE_LABEL[source]} · ${detail}`;
}
export const OWNER_DEFINITION = 'Owner is the person or system that made the change: the Arcana batch, approval or creation behind it, Amazon provider history when that is all Amazon reports, otherwise Unknown.';
/** Words for the state, entity type and field values shown in rows, filters and chips. */
export function words(value: string): string { return value.replaceAll('_',' '); }
const GRID_ENTITY: Readonly<Record<string, string>> = { campaign: 'campaigns', ad_group: 'ad_groups', keyword: 'targets', target: 'targets',
  negative: 'targets', product_ad: 'products', placement: 'placements' };
/** The grid page holding this row's entity and the menu words for it, or null when the grid has no level for it. */
export function gridLink(row: ChangeQueueEntry, profileId: string): { href: string; label: string } | null {
  const entity = GRID_ENTITY[row.entityType];
  if (entity === undefined) return null;
  const params = new URLSearchParams({ profile: profileId, entity });
  // Only the campaign level can be narrowed to one entity; every other level opens the whole list.
  if (row.entityType === 'campaign' && row.entityId !== '') {
    params.set('campaign', row.entityId);
    return { href: `/grid?${params}`, label: 'Open campaign in grid' };
  }
  return { href: `/grid?${params}`, label: `Open ${words(entity)} grid` };
}
/** A change tied to exactly one exported batch, so that batch's restore preview can open. */
export function restorable(row: ChangeQueueEntry): boolean {
  return row.batchId !== null && row.candidateCount <= 1 && (row.source === 'apply' || row.source === 'sync');
}
export function attribution(row: ChangeQueueEntry): string {
  if (row.source === 'campaign_creation') return `Approved creation · ${row.batchCount ?? 0} resources`;
  if (row.source === 'campaign_creation_retry') return row.batchLabel ?? 'Approved resource retry';
  const batch = row.batchLabel === null ? null : (/^Batch\s/i.test(row.batchLabel) ? row.batchLabel : `Batch ${row.batchLabel}`);
  if (row.candidateCount > 1) return `${batch === null ? '' : `${batch} · `}${row.candidateCount === 2 ? 'two' : row.candidateCount} rows could explain it`;
  if (row.source === 'queued' || (row.source === 'restore' && ['awaiting review', 'approved'].includes(row.state))) return 'Review proposal';
  if (row.source === 'amazon') {
    const evidence=row.amazonObservation;
    return `Provider history · no local actor · ${evidence?.marketplaceId??'marketplace unavailable'} · ${evidence?.resolution??'unresolved'}${evidence?.resolvedAmazonId?` ${evidence.resolvedEntityType} ${evidence.resolvedAmazonId}`:''} · derived identity (provider ID unavailable)${evidence?.identityConflict?' · identity conflict':''}`;
  }
  if (batch === null) return row.source === 'apply' ? 'Approved application' : 'Unknown';
  return `${batch} · ${row.experimentStart ? 'experiment start' : row.batchCount === null ? '— changes' : `${row.batchCount} changes`}`;
}
export const QUEUE_COLUMNS: GridColumn[] = [
  ['when','WHEN',130],['entity','ENTITY',280],['field','FIELD',96],['was','WAS',140],['became','BECAME',140],
  ['source','SOURCE',200],['attribution','OWNER',228],['state','STATE',150],
].map(([id,header,width]) => ({ id: String(id), header: String(header), width: Number(width), kind: 'dimension', scale: 'text', align: 'left' }));
export function queueModel(entries: readonly ChangeQueueEntry[], currencyCode: string) {
  return buildGridModel(entries.map((row) => ({ id: row.id, currencyCode, totals: ZERO_TOTALS, comparison: null,
    dimensions: { when: row.when, entity: row.entity, field: row.field,
      was: rawValue(row.oldValue), became: rawValue(row.newValue), source: sourceWords(row.source),
      attribution: attribution(row), state: row.state } })), { totals: 'none' });
}
function rawValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'object' ? JSON.stringify(value) : typeof value === 'number' || typeof value === 'boolean' ? value : String(value);
}
export function displayValue(value: unknown, field: string, currency: string): string {
  if (value === null || value === undefined) return '—';
  if (['bid','budget','budget_amount','default_bid'].includes(field) && (typeof value === 'number' || (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)))) {
    return new Intl.NumberFormat('en-US',{style:'currency',currency}).format(Number(value));
  }
  if (field === 'placement' && typeof value === 'number') return `+${value}%`;
  return String(rawValue(value));
}
