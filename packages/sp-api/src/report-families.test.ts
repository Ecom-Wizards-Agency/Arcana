import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { SpParsedReport, type SpReportFamily } from '@wizard-ads/shared';
import { SpApiClient } from './client.js';
import { parseSalesTraffic } from './sales-traffic.js';
import { parseAbaSearchTerms } from './aba-search-terms.js';
import { parseCatalogueListings } from './catalogue-listings.js';
import { SP_REPORT_CONTRACT, SP_REPORT_POLICY, SP_REPORT_TYPES, spReportRequest, type SpParseContext } from './report-families.js';

// Independently authored synthetic rows; pinned contract provenance is in fixtures/README.md.
function context(family: SpReportFamily): SpParseContext {
  return { plan: { scope: { orgId: '11111111-1111-4111-8111-111111111111', profileId: '22222222-2222-4222-8222-222222222222',
    connectionId: '33333333-3333-4333-8333-333333333333', marketplaceId: 'synthetic-market', sellingPartnerId: 'synthetic-seller', region: 'EU' },
    family, requestId: `synthetic-${family}`, start: family === 'aba' ? '2026-09-06' : family === 'catalogue' ? '2026-09-15' : '2026-09-12', end: family === 'catalogue' ? '2026-09-15' : '2026-09-12',
    requestedAt: '2026-09-15T00:00:00.000Z', contractVersion: SP_REPORT_CONTRACT },
    reportId: `report-${family}`, documentId: `document-${family}`, observedAt: '2026-09-15T01:00:00.000Z' };
}
function specification(ctx: SpParseContext) {
  return { reportType: SP_REPORT_TYPES[ctx.plan.family], reportOptions: spReportRequest(ctx.plan).reportOptions,
    dataStartTime: ctx.plan.start, dataEndTime: ctx.plan.end, marketplaceIds: [ctx.plan.scope.marketplaceId] };
}
const sales = { orderedProductSales: { amount: 120, currencyCode: 'EUR' }, unitsOrdered: 6, totalOrderItems: 4 };
const traffic = { sessions: 30, pageViews: 45, unitSessionPercentage: 20 };
function retail() {
  return { reportSpecification: specification(context('retail')),
    salesAndTrafficByDate: [{ date: '2026-09-12', salesByDate: structuredClone(sales), trafficByDate: { ...traffic } }],
    salesAndTrafficByAsin: [{ parentAsin: 'B000000099', childAsin: 'B000000001', salesByAsin: structuredClone(sales), trafficByAsin: { ...traffic } }] };
}
function slots() {
  return [1, 2, 3].map(slot => ({ departmentName: 'Synthetic department', searchTerm: 'fixture query', searchFrequencyRank: 17,
    clickShareRank: slot, clickedAsin: `B00000000${slot}`, clickShare: (4 - slot) / 10, conversionShare: (4 - slot) / 20 }));
}
function aba(rows: unknown[] = slots()) {
  return JSON.stringify({ reportSpecification: specification(context('aba')), dataByDepartmentAndSearchTerm: rows });
}
function reconcile(report: SpParsedReport, expected: Partial<SpParsedReport['counts']>) {
  expect(report.counts).toMatchObject(expected);
  const c = report.counts;
  expect(c.sourceRows).toBe(c.parsedRows + c.refusedRows);
  expect(c.canonicalRows).toBe(c.parsedRows - c.duplicateRows + c.addedRows);
  expect(c.canonicalRows).toBe(report.rows.length);
  expect(new Set(report.rows.map(row => row.key)).size).toBe(report.rows.length);
}
const listingHeader = 'listing-id\tseller-sku\tasin1\titem-name\tquantity\tstatus';
const listing = `${listingHeader}\nlisting-a\tsku-a\tB000000001\tSynthetic listing\t3\tActive\n`;

describe('pinned SP-API report planners', () => {
  it('uses one-day CHILD/DAY retail, one provider ABA week and localized listing requests', () => {
    expect(spReportRequest(context('retail').plan)).toMatchObject({ reportType: 'GET_SALES_AND_TRAFFIC_REPORT',
      dataStartTime: '2026-09-12T00:00:00.000Z', dataEndTime: '2026-09-12T23:59:59.999Z',
      reportOptions: { dateGranularity: 'DAY', asinGranularity: 'CHILD' } });
    expect(spReportRequest(context('aba').plan).reportOptions).toEqual({ reportPeriod: 'WEEK' });
    expect(spReportRequest(context('catalogue').plan).reportOptions).toEqual({ preferredReportDocumentLocale: 'en_US' });
    expect(SP_REPORT_POLICY.retail.lookbackCalendarYears).toBe(2);
    expect(SP_REPORT_POLICY.aba.lookbackCalendarYears).toBeNull();
    expect(SP_REPORT_POLICY.catalogue.lookbackCalendarYears).toBeNull();
  });
  it('rejects wrong contract, multi-day child aggregates, invalid ABA boundaries and future dates', () => {
    const p = context('retail').plan;
    for (const invalid of [{ ...p, contractVersion: 'unreviewed' }, { ...p, start: '2026-09-11' },
      { ...p, start: '2026-09-16', end: '2026-09-16' }, { ...p, start: '2024-09-14', end: '2024-09-14' },
      { ...context('aba').plan, start: '2026-09-07' }]) expect(() => spReportRequest(invalid)).toThrow();
    expect(() => spReportRequest({ ...p, start: '2024-09-15', end: '2024-09-15' })).not.toThrow();
  });
  it('refuses a provider week until its last calendar day has finished', () => {
    expect(() => spReportRequest({ ...context('aba').plan, requestedAt: '2026-09-12T12:00:00.000Z' })).toThrow();
  });
});

describe('Sales and Traffic fixtures', () => {
  it('retains total and child grains separately with exact amounts and provenance', () => {
    const r = parseSalesTraffic(JSON.stringify(retail()), context('retail'));
    reconcile(r, { sourceRows: 2, parsedRows: 2, refusedRows: 0, canonicalRows: 2, duplicateRows: 0, addedRows: 0 });
    expect(r.complete).toBe(true);
    expect(r.rows).toEqual(expect.arrayContaining([expect.objectContaining({ grain: 'total', asin: null, sales: 120, currency: 'EUR' }),
      expect.objectContaining({ grain: 'child', asin: 'B000000001', date: '2026-09-12', units: 6, sessions: 30 })]));
    expect(r.observedAt).toBe(context('retail').observedAt);
    expect(r.payloadFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
  it('keeps missing sessions unavailable and zero sessions as a measured zero', () => {
    const raw = retail();
    Reflect.deleteProperty(raw.salesAndTrafficByAsin[0]!.trafficByAsin, 'sessions');
    raw.salesAndTrafficByDate[0]!.trafficByDate.sessions = 0;
    const r = parseSalesTraffic(JSON.stringify(raw), context('retail'));
    reconcile(r, { sourceRows: 2, parsedRows: 2, refusedRows: 0 });
    expect(r.complete).toBe(false);
    expect(r.rows[0]).toMatchObject({ sessions: 0 });
    expect(r.rows[1]).toMatchObject({ sessions: null });
  });
  it('refuses invalid money and retains valid differently denominated rows without merging', () => {
    const raw = retail();
    raw.salesAndTrafficByAsin[0]!.salesByAsin.orderedProductSales.currencyCode = 'usd';
    const invalid = parseSalesTraffic(JSON.stringify(raw), context('retail'));
    reconcile(invalid, { sourceRows: 2, parsedRows: 1, refusedRows: 1, canonicalRows: 1 });
    expect(invalid.complete).toBe(false);
    raw.salesAndTrafficByAsin[0]!.salesByAsin.orderedProductSales.currencyCode = 'USD';
    expect(parseSalesTraffic(JSON.stringify(raw), context('retail')).rows[1]).toMatchObject({ currency: 'USD' });
  });
  it('reconciles identical duplicates and marks conflicting restatements within a document partial', () => {
    const raw = retail();
    raw.salesAndTrafficByAsin.push(structuredClone(raw.salesAndTrafficByAsin[0]!));
    const identical = parseSalesTraffic(JSON.stringify(raw), context('retail'));
    reconcile(identical, { sourceRows: 3, parsedRows: 3, duplicateRows: 1, canonicalRows: 2 });
    expect(identical.complete).toBe(true);
    raw.salesAndTrafficByAsin[1]!.salesByAsin.unitsOrdered = 7;
    const conflict = parseSalesTraffic(JSON.stringify(raw), context('retail'));
    reconcile(conflict, { sourceRows: 3, parsedRows: 3, duplicateRows: 1, canonicalRows: 2 });
    expect(conflict.complete).toBe(false);
  });
  it('refuses row dates outside the admitted day and rejects mismatched report periods', () => {
    const raw = retail(); raw.salesAndTrafficByDate[0]!.date = '2026-09-11';
    const r = parseSalesTraffic(JSON.stringify(raw), context('retail'));
    reconcile(r, { sourceRows: 2, parsedRows: 1, refusedRows: 1 });
    raw.reportSpecification.dataEndTime = '2026-09-13';
    expect(() => parseSalesTraffic(JSON.stringify(raw), context('retail'))).toThrow('specification');
  });
});

describe('ABA department/query/slot fixtures', () => {
  it('adds one query row to three ranked slots and preserves shares and frequency rank', () => {
    const r = parseAbaSearchTerms(aba(), context('aba'));
    reconcile(r, { sourceRows: 3, parsedRows: 3, refusedRows: 0, addedRows: 1, canonicalRows: 4 });
    expect(r.complete).toBe(true);
    expect(r.rows.every(row => row.kind === 'aba' && row.complete)).toBe(true);
    expect(r.rows[0]).toMatchObject({ slot: 0, asin: null, clickShare: null, conversionShare: null, frequencyRank: 17 });
    expect(r.rows[1]).toMatchObject({ slot: 1, asin: 'B000000001', clickShare: 0.3, conversionShare: 0.15 });
  });
  it('keeps identical queries from different departments separate', () => {
    const r = parseAbaSearchTerms(aba([...slots(), ...slots().map(row => ({ ...row, departmentName: 'Other department' }))]), context('aba'));
    reconcile(r, { sourceRows: 6, parsedRows: 6, addedRows: 2, canonicalRows: 8 });
    expect(r.complete).toBe(true);
  });
  it('does not manufacture a missing query, and incomplete slots cannot prove absence', () => {
    const r = parseAbaSearchTerms(aba(slots().slice(0, 2)), context('aba'));
    reconcile(r, { sourceRows: 2, parsedRows: 2, addedRows: 1, canonicalRows: 3 });
    expect(r.complete).toBe(false);
    expect(r.rows.every(row => row.kind === 'aba' && !row.complete)).toBe(true);
    expect(r.rows.some(row => row.kind === 'aba' && row.query === 'absent query')).toBe(false);
  });
  it('deduplicates identical slots and rejects conflicting slots as complete evidence', () => {
    const input = slots();
    const same = parseAbaSearchTerms(aba([...input, input[0]]), context('aba'));
    reconcile(same, { sourceRows: 4, parsedRows: 4, duplicateRows: 1, addedRows: 1, canonicalRows: 4 });
    expect(same.complete).toBe(true);
    const conflict = parseAbaSearchTerms(aba([...input, { ...input[0], clickedAsin: 'B000000009' }]), context('aba'));
    reconcile(conflict, { sourceRows: 4, parsedRows: 4, duplicateRows: 1, addedRows: 1, canonicalRows: 4 });
    expect(conflict.complete).toBe(false);
    expect(conflict.rows.every(row => row.kind === 'aba' && !row.complete)).toBe(true);
  });
  it('counts malformed rows and retains absent share as null', () => {
    const input: unknown[] = [...slots(), { ...slots()[0], clickShareRank: 4 }, { ...slots()[0], clickShare: 2 }, null];
    const r = parseAbaSearchTerms(aba(input), context('aba'));
    reconcile(r, { sourceRows: 6, parsedRows: 3, refusedRows: 3, addedRows: 1, canonicalRows: 4 });
    expect(r.complete).toBe(false);
    const missing = slots(); Reflect.deleteProperty(missing[0]!, 'conversionShare');
    const partial = parseAbaSearchTerms(aba(missing), context('aba'));
    expect(partial.rows[1]).toMatchObject({ conversionShare: null, complete: false });
  });
});

describe('listing document fixtures', () => {
  it('refuses historical requests and cross-day snapshots while preserving original replay dates', () => {
    const ctx = context('catalogue');
    expect(() => spReportRequest({ ...ctx.plan, start: '2026-09-14', end: '2026-09-14' })).toThrow('observation day');
    expect(() => parseCatalogueListings(listing, { ...ctx, observedAt: '2026-09-16T00:01:00.000Z' })).toThrow('observation differs');
    expect(() => parseCatalogueListings(listing, { ...ctx, observedAt: '2026-09-14T23:59:59.000Z' })).toThrow('observation differs');
    const replay = parseCatalogueListings(listing, ctx);
    expect(replay.observedAt).toBe(ctx.observedAt);
    expect(replay.rows[0]?.date).toBe('2026-09-15');
    expect(() => SpParsedReport.parse({ ...replay, observedAt: '2026-09-16T00:01:00.000Z' })).toThrow('actual request and observation day');
    expect(() => SpParsedReport.parse({ ...replay, plan: { ...replay.plan, start: '2026-09-14', end: '2026-09-14' } })).toThrow('actual request and observation day');
  });
  it('reads BOM, quoted tabs/newlines and doubled quotes without losing identities', () => {
    const text = `\uFEFF${listingHeader}\r\nlisting-a\tsku-a\tB000000001\t"Synthetic\tname\nwith ""quotes"""\t3\tActive\r\n`;
    const r = parseCatalogueListings(text, context('catalogue'));
    reconcile(r, { sourceRows: 1, parsedRows: 1, refusedRows: 0, canonicalRows: 1 });
    expect(r.rows[0]).toMatchObject({ listingId: 'listing-a', sku: 'sku-a', fields: { title: 'Synthetic\tname\nwith "quotes"', quantity: 3, status: 'Active' } });
  });
  it('preserves missing fields, deduplicates rows and refuses malformed inventories', () => {
    const minimal = 'listing-id\tseller-sku\tasin1\nlisting-a\tsku-a\tB000000001\nlisting-a\tsku-a\tB000000001\n';
    const r = parseCatalogueListings(minimal, context('catalogue'));
    reconcile(r, { sourceRows: 2, parsedRows: 2, duplicateRows: 1, canonicalRows: 1 });
    expect(r.rows[0]).toMatchObject({ fields: {} });
    const truncated = parseCatalogueListings(`${listing}listing-b\tsku-b\n`, context('catalogue'));
    reconcile(truncated, { sourceRows: 2, parsedRows: 1, refusedRows: 1, canonicalRows: 1 });
    expect(truncated.complete).toBe(false);
    expect(() => parseCatalogueListings(`${listingHeader}\n"unterminated`, context('catalogue'))).toThrow('Truncated');
    expect(() => parseCatalogueListings('listing-id\tseller-sku\n', context('catalogue'))).toThrow('headers');
  });
  it.each([false, true])('downloads and parses real text transport with GZIP=%s and zero auth access', async compressed => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init).toEqual({ method: 'GET' });
      return new Response(compressed ? new Uint8Array(gzipSync(listing)) : listing);
    });
    const client = new SpApiClient({ endpoint: 'https://provider.invalid', userAgent: 'Fixture/1', fetch,
      accessTokenProvider: { getAccessToken: async () => { throw new Error('Document download must not authenticate'); } } });
    const text = await client.downloadReportDocumentText({ url: 'https://document.invalid/fixture', reportDocumentId: 'document-catalogue', compressionAlgorithm: compressed ? 'GZIP' : null });
    reconcile(parseCatalogueListings(text, context('catalogue')), { sourceRows: 1, parsedRows: 1, canonicalRows: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('empty versus broken JSON evidence', () => {
  it('shared contracts reject complete evidence with refused source rows', () => {
    const raw = parseSalesTraffic(JSON.stringify(retail()), context('retail'));
    expect(() => SpParsedReport.parse({ ...raw, complete: true, counts: { ...raw.counts, sourceRows: 3, refusedRows: 1 } })).toThrow('Complete report');
  });
  it('allows explicitly empty collections but rejects absent collections or truncated JSON', () => {
    const raw = retail(); raw.salesAndTrafficByDate = []; raw.salesAndTrafficByAsin = [];
    const empty = parseSalesTraffic(JSON.stringify(raw), context('retail'));
    reconcile(empty, { sourceRows: 0, parsedRows: 0, refusedRows: 0, canonicalRows: 0 });
    expect(empty.complete).toBe(true);
    expect(parseAbaSearchTerms(aba([]), context('aba')).complete).toBe(true);
    Reflect.deleteProperty(raw, 'salesAndTrafficByAsin');
    expect(() => parseSalesTraffic(JSON.stringify(raw), context('retail'))).toThrow('collection');
    expect(() => parseSalesTraffic('{"reportSpecification":', context('retail'))).toThrow('Truncated');
    expect(() => parseAbaSearchTerms(aba().slice(0, -2), context('aba'))).toThrow('Truncated');
  });
});
