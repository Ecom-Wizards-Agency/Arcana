import type { RecommendationRecord } from '@wizard-ads/db';
import type { MethodEvaluatorInput } from '@wizard-ads/shared';
import type { SpWritePreview } from '@wizard-ads/shared/sp-write-application';

export function money(value: unknown, currency: string, missing = 'Unavailable'): string {
  if (value === null || value === undefined || value === '') return missing;
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : NaN;
  return Number.isFinite(number) ? new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(number) : missing;
}

export function changeValue(value: unknown, field: string, currency: string): string {
  if (value === null || value === undefined) return 'Unavailable';
  if (typeof value === 'object' && 'amount' in value) return money(value.amount, currency);
  if (['bid', 'defaultBid', 'budget', 'target_bid'].includes(field)) return money(value, currency);
  if (typeof value === 'object') return Object.entries(value).map(([key, item]) => `${key.replaceAll('_', ' ')}: ${changeValue(item, field, currency)}`).join(' · ');
  return ['placement', 'placement_adjustment', 'audience_adjustment'].includes(field) ? `${value}%` : String(value);
}

export function operationValue(value: unknown, action: SpWritePreview['plan']['actions'][number] | undefined, currency: string): string {
  const fields = Object.keys(action?.changes ?? {});
  if (fields.length === 1) {
    let decoded = value;
    if (typeof value === 'string' && value.startsWith('{')) { try { decoded = JSON.parse(value); } catch { return 'Unavailable'; } }
    return changeValue(decoded, fields[0]!, currency);
  }
  return value == null ? 'Unavailable' : String(value);
}

export function goalLabel(role: string | null): string {
  const labels: Record<string, string> = { profit: 'Profit', rank: 'Organic growth', discovery: 'Discovery', shield: 'Brand protection' };
  return role === null ? 'No saved goal' : labels[role] ?? 'Saved goal unavailable';
}

/** Read the exact target snapshot. Missing or ambiguous evidence gets a plain label. */
export function recommendationReason(row: RecommendationRecord, snapshots: readonly MethodEvaluatorInput[] = []): string {
  const labels = { high_acos: 'ACOS above target', low_acos: 'ACOS below target', high_spend_no_sales: 'Spend without sales', low_visibility: 'Low visibility', flag: 'Flagged for review', pacing: 'Pacing adjustment' };
  if (row.reason !== 'high_acos' && row.reason !== 'low_acos') return labels[row.reason];
  const matches = snapshots.filter((snapshot) => snapshot.runId === row.runId && snapshot.profileId === row.profileId
    && snapshot.methodId === row.inputs.methodId && snapshot.methodVersion === row.inputs.methodVersion)
    .flatMap((snapshot) => snapshot.evidenceRows.filter((evidence) => evidence.entityRef.entityId === row.entityId
      && evidence.entityRef.entityType === row.entityType && evidence.entityRef.campaignId === row.campaignId)
      .map((evidence) => ({ metrics: evidence.metrics, target: snapshot.resolvedSettings['targetAcos']?.value })));
  if (matches.length !== 1) return labels[row.reason];
  const { metrics, target } = matches[0]!;
  if (metrics.cost === undefined || metrics.sales <= 0 || typeof target !== 'number' || target <= 0) return labels[row.reason];
  const percent = (value: number) => new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 }).format(value);
  return `ACOS ${percent(metrics.cost / metrics.sales)} against a ${percent(target)} target`;
}
