import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { seedRecordedSpWritePreview } from '../../e2e/support/sp-write-preview';

const available = await databaseAvailable();
describe.skipIf(!available)('recorded approval browser fixture', () => {
  let database: TestDatabase;
  beforeAll(async () => { database = await createTestDatabase('approval_browser_fixture'); }, 60_000);
  afterAll(async () => { await database?.drop(); });

  it('produces one ready recorded plan and no approval or queued write', async () => {
    const fixture = await seedRecordedSpWritePreview(database);
    expect(fixture.review.freshness).toMatchObject({ status: 'current', reasons: [] });
    expect(fixture.review.admission).toBeNull();
    expect(fixture.review.preview.plan.counts.providerRows).toBe(1);
    expect(fixture.approvalPath).toBe(`/writes/${fixture.planId}?profile=${fixture.profileId}`);
    const [counts] = await database.sql`select
      (select count(*)::int from public.sp_write_plans where plan_id = ${fixture.planId}) as plans,
      (select count(*)::int from public.sp_write_plan_actions where plan_id = ${fixture.planId}) as actions,
      (select count(*)::int from public.sp_write_authorization_receipts where plan_id = ${fixture.planId}) as receipts,
      (select count(*)::int from public.sp_write_outbox where plan_id = ${fixture.planId}) as wakes`;
    expect(counts).toEqual({ plans: 1, actions: 1, receipts: 0, wakes: 0 });
  });
});
