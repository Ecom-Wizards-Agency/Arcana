import { describe, expect, it } from 'vitest';
import type { SpEvidence, SpParsedReport, SpReportRow, SpRetailSpendEvidence } from '@wizard-ads/shared';
import { abaEvidence, listingChanges, retailEvidence, retailTacos, retailComparison } from './spapi-evidence.js';
const scope = { orgId: '11111111-1111-4111-8111-111111111111', profileId: '22222222-2222-4222-8222-222222222222', connectionId: '33333333-3333-4333-8333-333333333333', sellingPartnerId: 'synthetic-seller', marketplaceId: 'synthetic-market', region: 'EU' as const };
function report(rows: SpReportRow[], family: 'retail' | 'aba' | 'catalogue' = 'retail', observedAt = '2026-09-09T12:00:00.000Z'): SpParsedReport {
  return { plan: { scope, family, requestId: 'synthetic-request', start: family === 'catalogue' ? observedAt.slice(0, 10) : '2026-09-06', end: family === 'catalogue' ? observedAt.slice(0, 10) : '2026-09-07', requestedAt: observedAt, contractVersion: 'synthetic-contract-v1' },
    reportId: observedAt, documentId: 'synthetic-document', observedAt, payloadFingerprint: 'a'.repeat(64), complete: true, rows,
    counts: { sourceRows: rows.length, parsedRows: rows.length, refusedRows: 0, duplicateRows: 0, addedRows: 0, canonicalRows: rows.length } };
}
function retailRows(): SpReportRow[] { return ['2026-09-06', '2026-09-07'].flatMap((date, i) => [
  { kind: 'retail' as const, key: date, date, grain: 'total' as const, asin: null, parentAsin: null, sales: 100 * (i + 1), currency: 'EUR', units: 10 * (i + 1), sessions: 100, pageViews: 200, orderItems: 5, reportedUnitSessionPercentage: null },
  { kind: 'retail' as const, key: `${date}:child`, date, grain: 'child' as const, asin: 'B000000001', parentAsin: null, sales: 100, currency: 'EUR', units: 10, sessions: 50, pageViews: 100, orderItems: 5, reportedUnitSessionPercentage: null },
]); }
const evidence = (value: SpParsedReport): SpEvidence => ({ state: 'measured', reason: null, report: value });
const window = { start: '2026-09-06', end: '2026-09-07' };
const spend: SpRetailSpendEvidence = { ...scope, ...window, currency: 'EUR', complete: true, scope: 'seller', rows: [{ date: window.start, spend: 10 }, { date: window.end, spend: 20 }] };
describe('retail evidence', () => {
  it('separates total and ASIN grains and recomputes compatible summed conversion and TACOS', () => {
    const value = evidence(report(retailRows()));
    expect(retailEvidence(value, window)).toMatchObject({ sales: 300, units: 30, sessions: 200, sourceRows: 2, conversion: 0.15, complete: true });
    expect(retailEvidence(value, { ...window, asin: 'B000000001' })).toMatchObject({ sales: 200, sessions: 100, conversion: 0.2 });
    expect(retailTacos(value, spend)).toBe(0.1);
  });
  it('profile provenance cannot multiply a seller total', () => {
    const value = evidence(report(retailRows()));
    const anotherProfile = structuredClone(value); anotherProfile.report!.plan.scope.profileId = '44444444-4444-4444-8444-444444444444';
    expect(retailTacos(value, spend)).toEqual(retailTacos(anotherProfile, spend));
  });
  it.each(['currency', 'sellingPartnerId', 'marketplaceId', 'orgId', 'start', 'end'] as const)('refuses mismatched %s', key => {
    expect(retailTacos(evidence(report(retailRows())), { ...spend, [key]: 'mismatch' })).toBeNull();
  });
  it.each([null, 0])('does not measure conversion with sessions %s', sessions => {
    const rows = retailRows().map(row => row.kind === 'retail' ? { ...row, sessions } : row);
    expect(retailEvidence(evidence(report(rows)), window).conversion).toBeNull();
  });
  it('refuses partial, stale, duplicate spend and mixed money', () => {
    const value = evidence(report(retailRows()));
    expect(retailTacos({ ...value, state: 'partial' }, spend)).toBeNull();
    expect(retailTacos({ ...value, state: 'stale' }, spend)).toBeNull();
    expect(retailTacos(value, { ...spend, rows: [spend.rows[0]!, spend.rows[0]!] })).toBeNull();
    const rows = retailRows().map(row => row.kind === 'retail' && row.date === window.end ? { ...row, currency: 'USD' } : row);
    expect(retailEvidence(evidence(report(rows)), window)).toMatchObject({ sales: null, currency: null });
  });
});
const abaRows = (): SpReportRow[] => [1, 2, 3].map(slot => ({ kind: 'aba', key: String(slot), date: window.start, end: window.end,
  department: 'Synthetic', query: 'test query', frequencyRank: 42, slot, asin: `B00000000${slot}`, clickShare: 0.2, conversionShare: 0.1, complete: true }));
const match = { ...window, query: 'test query', asin: 'B000000009' };
describe('ABA evidence', () => {
  it('uses all three ranked slots to prove observed absence without assigning zero shares', () => {
    const value = evidence(report(abaRows(), 'aba'));
    expect(abaEvidence(value, match)).toMatchObject({ state: 'not-top-three', clickShare: null, conversionShare: null });
    expect(abaEvidence(value, { ...match, asin: 'B000000002' })).toMatchObject({ state: 'present', slot: 2, clickShare: 0.2 });
  });
  it('keeps missing query, missing slots and partial reports unmeasured', () => {
    const value = evidence(report(abaRows(), 'aba'));
    expect(abaEvidence(value, { ...match, query: 'missing' }).state).toBe('not-measured');
    expect(abaEvidence(evidence(report(abaRows().slice(0, 2), 'aba')), match).state).toBe('not-measured');
    expect(abaEvidence({ ...value, state: 'partial' }, match).state).toBe('not-measured');
    expect(abaEvidence(value, { ...match, end: '2026-09-08' }).state).toBe('not-measured');
  });
  it('withholds identity and shares when a canonical slot retains source conflicts',()=>{
    const rows=abaRows().map(row=>row.kind==='aba'&&row.slot===1?{...row,conflicted:true,complete:false}:row);
    const value=evidence({...report(rows,'aba'),complete:false});
    expect(abaEvidence(value,{...match,asin:'B000000001'})).toMatchObject({state:'not-measured',slot:null,clickShare:null,conversionShare:null});
    const legacy=rows.map(row=>row.kind==='aba'?{...row,conflicted:undefined}:row);
    expect(abaEvidence(evidence({...report(legacy,'aba'),complete:false}),{...match,asin:'B000000001'}).state).toBe('not-measured');
  });
  it('refuses duplicate slots and ambiguous departments', () => {
    expect(abaEvidence(evidence(report([...abaRows(), abaRows()[0]!], 'aba')), match).state).toBe('not-measured');
    const extra = abaRows().map(row => row.kind === 'aba' ? { ...row, department: 'Other' } : row);
    expect(abaEvidence(evidence(report([...abaRows(), ...extra], 'aba')), match).state).toBe('not-measured');
    expect(abaEvidence(evidence(report([...abaRows(), ...extra], 'aba')), { ...match, department: 'Synthetic' }).state).toBe('not-top-three');
  });
});
function listing(title: string | undefined, at: string) {
  return report([{ kind: 'catalogue', key: 'listing', date: at.slice(0, 10), listingId: 'synthetic-listing', sku: 'synthetic-sku', asin: 'B000000001', fields: title === undefined ? {} : { title } }], 'catalogue', at);
}
describe('listing observation certainty', () => {
  const a = () => listing('First title', '2026-09-06T12:00:00.000Z');
  const b = () => listing('New title', '2026-09-07T12:00:00.000Z');
  it('uses adjacent source observations, with first and exact certainty', () => {
    const changes = listingChanges([a(), b()]);
    expect(changes).toHaveLength(2);
    expect(changes[0]?.certainty.kind).toBe('first');
    expect(changes[1]).toMatchObject({ before: 'First title', after: 'New title', certainty: { kind: 'exact' } });
  });
  it('sorts older replay and deduplicates report replay without advancing observation time', () => {
    expect(listingChanges([b(), a(), b()])).toEqual(listingChanges([a(), b()]));
  });
  it('source change and missing fields start new observation certainty', () => {
    const next = b(); next.plan.contractVersion = 'synthetic-contract-v2';
    expect(listingChanges([a(), next])[1]?.certainty.kind).toBe('first');
    expect(listingChanges([a(), listing(undefined, '2026-09-07T12:00:00.000Z'), listing('Later', '2026-09-08T12:00:00.000Z')])[1]?.certainty.kind).toBe('first');
  });
  it('gaps are windows and interrupted inventories cannot imply deletions', () => {
    expect(listingChanges([a(), listing('Later', '2026-09-09T12:00:00.000Z')])[1]?.certainty.kind).toBe('window');
    const interrupted = report([], 'catalogue', '2026-09-07T12:00:00.000Z'); interrupted.complete = false;
    const changes = listingChanges([a(), interrupted, listing('Later', '2026-09-08T12:00:00.000Z')]);
    expect(changes).toHaveLength(2); expect(changes[1]?.certainty.kind).toBe('first');
  });
});
it('keeps saved listing certainty when an older source observation is replayed later', () => {
  const first = listing('First', '2026-09-06T12:00:00.000Z');
  const latest = listing('Latest', '2026-09-09T12:00:00.000Z');
  latest.listingChanges = listingChanges([first, latest]).filter(change => change.observedAt === latest.observedAt);
  latest.listingPreviousReportId = first.reportId;
  expect(latest.listingChanges[0]?.certainty.kind).toBe('window');
  const replay = listing('Middle', '2026-09-08T12:00:00.000Z');
  expect(listingChanges([first, replay, latest]).filter(change => change.observedAt === latest.observedAt)).toEqual(latest.listingChanges);
  latest.listingChanges = [];
  expect(listingChanges([first, replay, latest]).some(change => change.observedAt === latest.observedAt)).toBe(false);
});

it('reports traffic change separately from conversion change on compatible periods', () => {
  const current = retailEvidence(evidence(report(retailRows())), window);
  const previous = { ...current, sessions: 100, conversion: 0.1, start: '2026-09-04', end: '2026-09-05' };
  expect(retailComparison(current, previous)).toMatchObject({ trafficChange: 1 });
  expect(retailComparison(current, previous).conversionChange).toBeCloseTo(0.05);
  expect(retailComparison(current, { ...previous, scopeKey: 'another-seller' })).toEqual({ trafficChange: null, conversionChange: null });
  expect(retailComparison(current, { ...previous, sessions: 0 }).trafficChange).toBeNull();
});
