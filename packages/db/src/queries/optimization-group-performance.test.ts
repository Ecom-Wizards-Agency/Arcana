import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { readOptimizationGroupPerformance } from './optimization-group-performance.js';
let database: TestDatabase;
let orgId: string, profileId: string, groupId: string;
beforeAll(async () => {
  database = await createTestDatabase('wp269_group_performance');
  const rows = await database.sql<{ org_id: string }[]>`select app.seed_tenant_fixture('group-performance', '96969696-9696-4969-8969-969696969696', 'owner', '2026-08-11') as org_id`;
  orgId = rows[0]!.org_id;
  const profiles = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id = ${orgId}`;
  profileId = profiles[0]!.id;
  const groups = await database.sql<{ id: string }[]>`select id from public.optimization_groups where org_id = ${orgId} and profile_id = ${profileId}`;
  groupId = groups[0]!.id;
}, 60_000);
afterAll(async () => { await database?.drop(); });
it('returns null for an unowned group without leaking members', async () => {
  expect(await readOptimizationGroupPerformance(database, { orgId: '97979797-9797-4979-8979-979797979797', profileId, groupId, current: { start: '2026-08-10', end: '2026-08-11' }, previous: { start: '2026-08-08', end: '2026-08-09' } })).toBeNull();
});
it('keeps all metrics unavailable without reporting rows, then returns measured facts', async () => {
  const empty = await readOptimizationGroupPerformance(database, { orgId, profileId, groupId, current: { start: '2026-01-01', end: '2026-01-02' }, previous: { start: '2025-12-30', end: '2025-12-31' } });
  expect(empty).toMatchObject({ reportingRows: 0, previousReportingRows: 0, campaignIds: ['c-1'], current: { metrics: { spend: null, sales: null, orders: null, acos: null } } });
  const measured = await readOptimizationGroupPerformance(database, { orgId, profileId, groupId, current: { start: '2026-08-11', end: '2026-08-11' }, previous: { start: '2026-08-10', end: '2026-08-10' } });
  expect(measured?.reportingRows).toBe(1);
  expect(measured?.days).toHaveLength(1);
  expect(measured?.current.metrics).toEqual({ spend: 4.5, sales: 25, orders: 1, acos: .18 });
  expect(measured?.current.metrics.acos).toBeCloseTo(measured!.current.metrics.spend! / measured!.current.metrics.sales!);
  expect(measured?.previous.metrics.spend).toBeNull();
});
