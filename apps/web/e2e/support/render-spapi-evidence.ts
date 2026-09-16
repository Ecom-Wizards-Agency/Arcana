/** Synthetic normalized observations rendered with the actual SP-API reader components. */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { SpEvidence, SpReportFamily, SpReportRow } from '@wizard-ads/shared';
Object.assign(globalThis, { React });
const styles: string[] = [];
registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.css')) {
    const css = readFileSync(fileURLToPath(url), 'utf8'); styles.push(css);
    const classes = Object.fromEntries([...css.matchAll(/\.([_a-zA-Z][_a-zA-Z0-9-]*)/g)].map(match => [match[1], match[1]]));
    return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(classes)};` };
  }
  return nextLoad(url, context);
} });
const { RetailEvidencePanel, AbaEvidencePanel, ListingEvidencePanel } = await import('../../src/screens/grid/spapi-evidence');
const scope = { orgId: '11111111-1111-4111-8111-111111111111', profileId: '22222222-2222-4222-8222-222222222222', connectionId: '33333333-3333-4333-8333-333333333333', sellingPartnerId: 'synthetic-seller', marketplaceId: 'synthetic-market', region: 'EU' as const };
function fixture(family: SpReportFamily, rows: SpReportRow[], state: SpEvidence['state']): SpEvidence {
  const period = { start: family === 'catalogue' ? '2026-09-13' : '2026-09-06', end: family === 'catalogue' ? '2026-09-13' : family === 'aba' ? '2026-09-12' : '2026-09-06' };
  return { state, reason: state === 'measured' ? null : state === 'partial' ? 'Some source rows were refused.' : state === 'stale' ? 'The source observation is stale.' : 'The source is disabled.',
    report: state === 'unavailable' ? null : {
      plan: { scope, family, requestId: `synthetic-${family}`, ...period, requestedAt: '2026-09-13T12:00:00.000Z', contractVersion: 'synthetic-contract-v1' },
      reportId: `synthetic-${family}`, documentId: 'synthetic-document', observedAt: '2026-09-13T12:00:00.000Z', payloadFingerprint: 'a'.repeat(64), rows, complete: state !== 'partial',
      counts: { sourceRows: rows.length + (state === 'partial' ? 1 : 0), parsedRows: rows.length, refusedRows: state === 'partial' ? 1 : 0, duplicateRows: 0, addedRows: 0, canonicalRows: rows.length },
    } };
}
const markup: Record<string, string> = {};
for (const state of ['measured', 'partial', 'stale', 'unavailable'] as const) {
  const retail = fixture('retail', [{ kind: 'retail', key: 'total', date: '2026-09-06', grain: 'total', asin: null, parentAsin: null,
    sales: 2400, currency: 'EUR', units: 120, sessions: 1000, pageViews: 1600, orderItems: 100, reportedUnitSessionPercentage: null }], state);
  const aba = fixture('aba', [1, 2, 3].map(slot => ({ kind: 'aba', key: String(slot), date: '2026-09-06', end: '2026-09-12',
    department: 'Synthetic department', query: 'synthetic query', frequencyRank: 17, slot, asin: `B00000000${slot}`, clickShare: 0.2, conversionShare: 0.1, complete: state !== 'partial' })), state);
  const listing = fixture('catalogue', [{ kind: 'catalogue', key: 'listing', date: '2026-09-13', listingId: 'synthetic-listing', sku: 'synthetic-sku', asin: 'B000000001', fields: { title: 'Observed synthetic listing title', quantity: 24 } }], state);
  const spend = { ...scope, start: '2026-09-06', end: '2026-09-06', currency: 'EUR', scope: 'seller' as const, complete: true, rows: [{ date: '2026-09-06', spend: 240 }] };
  markup[state] = renderToStaticMarkup(React.createElement('main', {},
    React.createElement('h1', {}, `SP-API evidence · ${state}`),
    React.createElement('p', {}, 'Synthetic fixtures · retail, ABA and catalogue observations'),
    React.createElement(RetailEvidencePanel, { evidence: retail, spend, start: '2026-09-06', end: '2026-09-06' }),
    React.createElement(AbaEvidencePanel, { evidence: aba, selectedAsin: 'B000000009' }),
    React.createElement(ListingEvidencePanel, { evidence: listing, reports: listing.report ? [listing.report] : [] }),
  ));
}
process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(markup).map(([state, html]) => [state, `<style>${styles.join('\n')}body{font:14px system-ui;margin:24px;color:#26313c;background:#f5f6f8}h1{font-size:24px}</style>${html}`]))));
