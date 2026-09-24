import type { ChangeQueueEntry } from '@wizard-ads/shared';
import { buildGridModel, ZERO_TOTALS, type GridColumn } from '@wizard-ads/ui';
export const SOURCE_LABEL = { apply: 'we sent it', sync: 'changed at Amazon', amazon: 'Amazon observed', queued: 'queued', restore: 'Restore' } as const;
export function attribution(row: ChangeQueueEntry): string {
  const batch = row.batchLabel === null ? null : (/^Batch\s/i.test(row.batchLabel) ? row.batchLabel : `Batch ${row.batchLabel}`);
  if (row.candidateCount > 1) return `${batch === null ? '' : `${batch} · `}${row.candidateCount === 2 ? 'two' : row.candidateCount} rows could explain it`;
  if (row.source === 'queued' || (row.source === 'restore' && ['awaiting review', 'approved'].includes(row.state))) return 'Review proposal';
  if (row.source === 'amazon') {
    const evidence=row.amazonObservation;
    return `Provider history · no local actor · ${evidence?.marketplaceId??'marketplace unavailable'} · ${evidence?.resolution??'unresolved'}${evidence?.resolvedAmazonId?` ${evidence.resolvedEntityType} ${evidence.resolvedAmazonId}`:''} · derived identity (provider ID unavailable)${evidence?.identityConflict?' · identity conflict':''}`;
  }
  if (batch === null) return row.source === 'apply' ? 'Approved application' : 'not ours';
  return `${batch} · ${row.experimentStart ? 'experiment start' : row.batchCount === null ? '— changes' : `${row.batchCount} changes`}`;
}
export const QUEUE_COLUMNS: GridColumn[] = [
  ['when','WHEN',130],['entity','ENTITY',300],['field','FIELD',96],['was','WAS',92],['became','BECAME',92],
  ['source','SOURCE',168],['attribution','ATTRIBUTED TO',300],['state','STATE',118],
].map(([id,header,width]) => ({ id: String(id), header: String(header), width: Number(width), kind: 'dimension', scale: 'text', align: 'left' }));
export function queueModel(entries: readonly ChangeQueueEntry[], currencyCode: string) {
  return buildGridModel(entries.map((row) => ({ id: row.id, currencyCode, totals: ZERO_TOTALS, comparison: null,
    dimensions: { when: row.when, entity: row.entity, field: row.field,
      was: rawValue(row.oldValue), became: rawValue(row.newValue), source: SOURCE_LABEL[row.source],
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
