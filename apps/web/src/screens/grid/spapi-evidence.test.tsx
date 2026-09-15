import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SpEvidence, SpParsedReport, SpReportRow } from '@wizard-ads/shared';
import { AbaEvidencePanel, ListingEvidencePanel, RetailEvidencePanel, SpSourceStatus } from './spapi-evidence';
const scope = { orgId: '11111111-1111-4111-8111-111111111111', profileId: '22222222-2222-4222-8222-222222222222', connectionId: '33333333-3333-4333-8333-333333333333', sellingPartnerId: 'synthetic-seller', marketplaceId: 'synthetic-market', region: 'EU' as const };
function fixture(rows: SpReportRow[], family: 'retail' | 'aba' | 'catalogue'): SpEvidence {
  const report: SpParsedReport = { plan: { scope, family, requestId: 'synthetic-request', start: family === 'catalogue' ? '2026-09-07' : '2026-09-06', end: family === 'catalogue' ? '2026-09-07' : '2026-09-06', requestedAt: '2026-09-07T12:00:00.000Z', contractVersion: 'synthetic-contract-v1' },
    reportId: 'synthetic-report', documentId: 'synthetic-document', observedAt: '2026-09-07T12:00:00.000Z', payloadFingerprint: 'a'.repeat(64), rows, complete: true,
    counts: { sourceRows: rows.length, parsedRows: rows.length, refusedRows: 0, duplicateRows: 0, addedRows: 0, canonicalRows: rows.length } };
  return { state: 'measured', reason: null, report };
}
it.each(['measured', 'partial', 'stale', 'unavailable'] as const)('names %s with source period and original observation time', state => {
  const source = fixture([], 'retail');
  const html = renderToStaticMarkup(<SpSourceStatus label="Retail" evidence={{ ...source, state }} />);
  expect(html).toContain(`data-state="${state}"`); expect(html).toContain('2026-09-06 to 2026-09-06');
  expect(html).toContain('observed 2026-09-07T12:00:00.000Z');
});
it('renders retail columns and computes conversion without claiming unproved TACOS', () => {
  const source = fixture([{ kind: 'retail', key: 'total', date: '2026-09-06', grain: 'total', asin: null, parentAsin: null,
    sales: 200, currency: 'EUR', units: 10, sessions: 100, pageViews: 200, orderItems: 5, reportedUnitSessionPercentage: null }], 'retail');
  const html = renderToStaticMarkup(<RetailEvidencePanel evidence={source} start="2026-09-06" end="2026-09-06" />);
  expect(html).toContain('Total retail sales'); expect(html).toContain('200 EUR'); expect(html).toContain('10.00%');
  expect(html).toContain('TACOS requires complete seller-wide');
});
it('only renders Not top 3 for a valid observed complete ranked result', () => {
  const source = fixture([1, 2, 3].map(slot => ({ kind: 'aba', key: String(slot), date: '2026-09-06', end: '2026-09-06',
    department: 'Synthetic department', query: 'synthetic query', frequencyRank: 17, slot, asin: `B00000000${slot}`, clickShare: 0.2, conversionShare: 0.1, complete: true })), 'aba');
  expect(renderToStaticMarkup(<AbaEvidencePanel evidence={source} selectedAsin="B000000009" />)).toContain('Not top 3');
  expect(renderToStaticMarkup(<AbaEvidencePanel evidence={{ ...source, state: 'partial' }} selectedAsin="B000000009" />)).not.toContain('Not top 3');
  expect(renderToStaticMarkup(<AbaEvidencePanel evidence={source} selectedAsin="B000000002" />)).toContain('Slot 2');
  expect(renderToStaticMarkup(<AbaEvidencePanel evidence={source} selectedAsin="B000000002" />)).toContain('20.00%');
  expect(renderToStaticMarkup(<AbaEvidencePanel evidence={source} selectedAsin="B000000009" query="missing" />)).not.toContain('Not top 3');
});
it('renders supported listing values with first observation certainty', () => {
  const source = fixture([{ kind: 'catalogue', key: 'listing', date: '2026-09-07', listingId: 'synthetic-listing', sku: 'synthetic-sku', asin: 'B000000001', fields: { title: 'Observed title' } }], 'catalogue');
  const html = renderToStaticMarkup(<ListingEvidencePanel evidence={source} reports={[source.report!]} />);
  expect(html).toContain('Observed title'); expect(html).toContain('first'); expect(html).toContain('Catalogue listing report');
});
it('renders measured TACOS only with matched independently verified seller spend', () => {
  const source = fixture([{ kind: 'retail', key: 'total', date: '2026-09-06', grain: 'total', asin: null, parentAsin: null,
    sales: 200, currency: 'EUR', units: 10, sessions: 100, pageViews: 200, orderItems: 5, reportedUnitSessionPercentage: null }], 'retail');
  const spend = { ...scope, start: '2026-09-06', end: '2026-09-06', currency: 'EUR', scope: 'seller' as const, complete: true, rows: [{ date: '2026-09-06', spend: 10 }] };
  const html = renderToStaticMarkup(<RetailEvidencePanel evidence={source} spend={spend} start="2026-09-06" end="2026-09-06" />);
  expect(html).toContain('5.00%'); expect(html).not.toContain('TACOS requires');
  const mismatch = renderToStaticMarkup(<RetailEvidencePanel evidence={source} spend={{ ...spend, marketplaceId: 'other-market' }} start="2026-09-06" end="2026-09-06" />);
  expect(mismatch).toContain('TACOS requires'); expect(mismatch).not.toContain('5.00%');
});
