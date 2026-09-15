import type { SpAbaRow, SpEvidence, SpParsedReport, SpRetailRow, SpRetailSpendEvidence, SpListingChange } from '@wizard-ads/shared';
import { creativeChangeCertainty } from './creative/certainty.js';

/** Retail money and traffic remain separate from ad-attributed performance. */
export function retailEvidence(evidence: SpEvidence, input: { start: string; end: string; asin?: string }) {
  const report = evidence.report;
  const rows = report?.rows.filter((row): row is SpRetailRow => row.kind === 'retail'
    && row.date >= input.start && row.date <= input.end
    && (input.asin === undefined ? row.grain === 'total' : row.grain === 'child' && row.asin === input.asin)) ?? [];
  const expectedDays = Math.round((Date.parse(input.end) - Date.parse(input.start)) / 86400000) + 1;
  const dates = new Set(rows.map(row => row.date));
  const exact = report?.plan.family === 'retail' && report.plan.start === input.start && report.plan.end === input.end
    && expectedDays > 0 && rows.length === expectedDays && dates.size === expectedDays;
  const sum = (field: 'sales' | 'units' | 'sessions' | 'pageViews') => rows.length && dates.size === rows.length && rows.every(row => row[field] !== null)
    ? rows.reduce((total, row) => total + row[field]!, 0) : null;
  const currencies = new Set(rows.flatMap(row => row.currency === null ? [] : [row.currency]));
  const currency = currencies.size === 1 ? [...currencies][0]! : null;
  const sales = currency === null ? null : sum('sales');
  const units = sum('units'), sessions = sum('sessions'), pageViews = sum('pageViews');
  const complete = evidence.state === 'measured' && report?.complete === true && exact;
  const state = evidence.state === 'measured' && !exact ? 'partial' as const : evidence.state;
  return { state, reason: !exact && report ? 'Retail dates or grain do not cover the selected period.' : evidence.reason,
    start: input.start, end: input.end, observedAt: report?.observedAt ?? null,
    scopeKey: report ? [report.plan.scope.orgId, report.plan.scope.sellingPartnerId, report.plan.scope.marketplaceId].join('\u0000') : null,
    currency, sales, units, sessions, pageViews, complete,
    conversion: complete && units !== null && sessions !== null && sessions > 0 ? units / sessions : null,
    sourceRows: rows.length };
}

/** The caller must supply verified seller-wide spend, never heuristic product spend. */
export function retailTacos(evidence: SpEvidence, spend: SpRetailSpendEvidence): number | null {
  const retail = retailEvidence(evidence, spend), report = evidence.report;
  if (!report || !retail.complete || !spend.complete || spend.scope !== 'seller' || report.plan.scope.orgId !== spend.orgId
    || report.plan.scope.sellingPartnerId !== spend.sellingPartnerId || report.plan.scope.marketplaceId !== spend.marketplaceId
    || retail.currency !== spend.currency || retail.sales === null || retail.sales <= 0) return null;
  const dates = new Set(spend.rows.map(row => row.date));
  if (dates.size !== retail.sourceRows || spend.rows.length !== dates.size || spend.rows.some(row => row.date < spend.start || row.date > spend.end
    || !Number.isFinite(row.spend) || row.spend < 0)) return null;
  return spend.rows.reduce((sum, row) => sum + row.spend, 0) / retail.sales;
}

/** Match one department/query and one provider period; slot shares are never ranks. */
export function abaEvidence(evidence: SpEvidence, input: { query: string; asin: string; start: string; end: string; department?: string }) {
  const report = evidence.report;
  const unknown = (reason: string) => ({ state: 'not-measured' as const, reason, frequencyRank: null, slot: null,
    clickShare: null, conversionShare: null, department: null });
  if (!/^[A-Z0-9]{10}$/.test(input.asin)) return unknown('Choose a valid ASIN.');
  if (!report || report.plan.family !== 'aba' || report.plan.start !== input.start || report.plan.end !== input.end)
    return unknown('No ABA report for this exact provider period.');
  const rows = report.rows.filter((row): row is SpAbaRow => row.kind === 'aba' && row.query === input.query
    && row.date === input.start && row.end === input.end && (input.department === undefined || row.department === input.department));
  const departments = new Set(rows.map(row => row.department));
  if (departments.size !== 1) return unknown(departments.size ? 'Choose a department for this query.' : 'Query not measured in this ABA period.');
  const slots = rows.filter(row => row.slot > 0);
  const ranks = new Set(rows.map(row => row.frequencyRank));
  if (ranks.size !== 1 || new Set(slots.map(row => row.slot)).size !== slots.length
    || new Set(slots.flatMap(row => row.asin === null ? [] : [row.asin])).size !== slots.length)
    return unknown('ABA ranked results are conflicting or incomplete.');
  const present = slots.find(row => row.asin === input.asin);
  if (present) return { state: 'present' as const, reason: evidence.reason, frequencyRank: present.frequencyRank,
    slot: present.slot, clickShare: present.clickShare, conversionShare: present.conversionShare, department: present.department };
  if (evidence.state !== 'measured' || !report.complete || slots.length !== 3 || !rows.every(row => row.complete)
    || ![1, 2, 3].every(slot => slots.some(row => row.slot === slot && row.asin !== null)))
    return unknown('The observed query does not contain three complete ranked results.');
  return { state: 'not-top-three' as const, reason: null, frequencyRank: rows[0]!.frequencyRank,
    slot: null, clickShare: null, conversionShare: null, department: rows[0]!.department };
}

/** Source switches, missing fields and interrupted inventories break continuity. */
export function listingChanges(reports: readonly SpParsedReport[], timezone = 'UTC') {
  const histories = new Map<string, { report: SpParsedReport; row: Extract<SpParsedReport['rows'][number], { kind: 'catalogue' }> }>();
  const output: SpListingChange[] = [];
  const seen = new Set<string>();
  const sorted = [...reports].filter(report => report.plan.family === 'catalogue').sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.reportId.localeCompare(b.reportId));
  for (const report of sorted) {
    const scope = report.plan.scope;
    const reportKey = [scope.orgId, scope.sellingPartnerId, scope.marketplaceId, scope.connectionId, report.plan.contractVersion, report.reportId].join('\u0000');
    if (seen.has(reportKey)) continue;
    seen.add(reportKey);
    if (report.listingChanges !== undefined) output.push(...report.listingChanges);
    const inventory = new Set<string>();
    for (const row of report.rows) {
      if (row.kind !== 'catalogue') continue;
      const key = [scope.orgId, scope.sellingPartnerId, scope.marketplaceId, row.listingId, row.sku, row.asin].join('\u0000');
      inventory.add(key);
      const previous = histories.get(key);
      const continuous = previous !== undefined && previous.report.plan.scope.connectionId === scope.connectionId
        && previous.report.plan.contractVersion === report.plan.contractVersion && previous.report.complete && report.complete
        && previous.report.observedAt < report.observedAt;
      for (const [field, value] of report.listingChanges === undefined ? Object.entries(row.fields) : []) {
        if (value === undefined) continue;
        const old = previous?.row.fields[field as keyof typeof row.fields];
        if (continuous && old === value) continue;
        const comparable = continuous && old !== undefined;
        output.push({ id: `${report.reportId}:${row.key}:${field}`, asin: row.asin, sku: row.sku, field,
          before: comparable ? old : null, after: value, observedAt: report.observedAt, source: report.plan.contractVersion,
          certainty: creativeChangeCertainty({ previous: comparable ? previous.report.observedAt : null,
            observedAt: report.observedAt, firstObservation: !comparable, timezone }) });
      }
      histories.set(key, { report, row });
    }
    // A listing absent from an inventory is unknown; the next observation starts a new comparison.
    const sellerPrefix = [scope.orgId, scope.sellingPartnerId, scope.marketplaceId].join('\u0000') + '\u0000';
    for (const key of histories.keys()) if (key.startsWith(sellerPrefix) && !inventory.has(key)) histories.delete(key);
  }
  return output;
}

/** Traffic change and conversion-point change use compatible, fully covered periods. */
export function retailComparison(current: ReturnType<typeof retailEvidence>, previous: ReturnType<typeof retailEvidence>) {
  const sameDuration = Date.parse(current.end) - Date.parse(current.start) === Date.parse(previous.end) - Date.parse(previous.start);
  const compatible = current.complete && previous.complete && current.scopeKey === previous.scopeKey && sameDuration;
  return {
    trafficChange: compatible && current.sessions !== null && previous.sessions !== null && previous.sessions > 0 ? current.sessions / previous.sessions - 1 : null,
    conversionChange: compatible && current.conversion !== null && previous.conversion !== null ? current.conversion - previous.conversion : null,
  };
}
