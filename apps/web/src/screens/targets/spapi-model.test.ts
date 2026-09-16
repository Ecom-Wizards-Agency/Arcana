import { expect, it, vi } from 'vitest';
import type { QueryHandle } from '@wizard-ads/db';
const provider = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@wizard-ads/db', () => ({ readSpReportEvidence: provider.read, readTargetBidContext: vi.fn() }));
import { loadTargetSearchEvidence } from './model';
const args = { orgId: 'synthetic-org', profileId: 'synthetic-profile', targetId: 'synthetic-target', from: '2026-09-06', to: '2026-09-12' };
const aba = { state: 'unavailable', reason: 'Disabled', report: null };
it('retains authenticated org/profile/period scope and refuses ambiguous target-ASIN attribution', async () => {
  provider.read.mockResolvedValue(aba);
  const sql = vi.fn().mockResolvedValue([{ asin: 'B000000001' }, { asin: 'B000000002' }]);
  const result = await loadTargetSearchEvidence({ sql } as unknown as QueryHandle, args, { targetKind: 'keyword', matchType: 'exact', targeting: 'test query' });
  expect(provider.read).toHaveBeenCalledWith({ sql }, { orgId: args.orgId, profileId: args.profileId, family: 'aba', start: args.from, end: args.to });
  expect(result).toEqual({ aba, asin: null, sqp: [] }); expect(sql).toHaveBeenCalledTimes(1);
  expect(sql.mock.calls[0]?.slice(1)).toEqual([args.orgId, args.profileId, args.targetId]);
});
it('reads counted SQP rows only for a unique target ASIN and literal query', async () => {
  provider.read.mockResolvedValue(aba);
  const rows = [{ asin: 'B000000001', query: 'test query', start: args.from, end: args.to, observedAt: '2026-09-13T12:00:00.000Z', impressionShare: 0.2, purchaseShare: 0.1 }];
  const sql = vi.fn().mockResolvedValueOnce([{ asin: 'B000000001' }]).mockResolvedValueOnce(rows);
  const result = await loadTargetSearchEvidence({ sql } as unknown as QueryHandle, args, { targetKind: 'keyword', matchType: 'exact', targeting: 'test query' });
  expect(result.sqp).toHaveLength(1); expect(result.sqp).toEqual(rows); expect(sql).toHaveBeenCalledTimes(2);
  expect(sql.mock.calls[1]?.slice(1)).toEqual([args.orgId, args.profileId, 'B000000001', 'test query', args.from, args.to]);
});
it('broad and product targeting do not acquire SQP query evidence', async () => {
  provider.read.mockResolvedValue(aba);
  const sql = vi.fn();
  for (const target of [{ targetKind: 'keyword', matchType: 'broad' }, { targetKind: 'product', matchType: null }]) {
    expect((await loadTargetSearchEvidence({ sql } as unknown as QueryHandle, args, { ...target, targeting: 'test query' })).sqp).toEqual([]);
  }
  expect(sql).not.toHaveBeenCalled();
});
