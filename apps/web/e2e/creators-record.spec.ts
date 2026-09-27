/**
 * `/creators/records/[id]` against a live authenticated Next process: the rung
 * that resolved the record, a candidate refused on one contact fingerprint, the
 * ten checks with the tracker score that disagrees, and everything since, with
 * a time the runner did not keep said so. Synthetic rows only; fingerprints are
 * SHA-256 over synthetic labels and never appear in full.
 */
import { createHash } from 'node:crypto';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createDb } from '@wizard-ads/db';
import { signIn } from './support/auth';
import { readState } from './support/fixture';

const COUNTS = '{"records":null,"action_log":null,"queue_items":null,"sweep_runs":null,"sample_shipments":null}';
const DIGEST = '0'.repeat(64);
const fp = (label: string) => createHash('sha256').update(`synthetic:e2e:${label}`).digest('hex');

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}-1440x1024.png`);
  await page.screenshot({ path, animations: 'disabled', style: 'nextjs-portal { display: none; }', fullPage: true });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

test('creator record: the rung, the refused candidate, the score that disagrees, and everything since', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 1024 });
  const state = await readState();
  const db = createDb({ connectionString: state.connectionString, max: 1 });
  try {
    const org = state.orgId;
    const email = fp('email-shared');
    await db.sql`insert into public.creator_records(org_id, creator_record_id, brand, campaign_id, storefront_fp, thread_fp, email_fp, record_state, lock_state,
        runner_version, created_on, last_verified_on, status, computed_score, missing_checks, qualified_on, tracker_score, tracker_scored_on, source, source_digest)
      values (${org}, 'CCR-E3-26-0134', 'Synthetic brand', 'campaign-e3', ${fp('storefront-0134')}, ${fp('thread-0134')}, ${email}, 'Active', 'Unlocked', 3,
        '2026-09-02', '2026-09-07', 'Verification Confirmed', 8, '{recent_post_verified,performance_or_revenue}'::text[], '2026-09-09', 10, '2026-09-09',
        'control-runner', ${DIGEST}) on conflict do nothing`;
    // Shares one contact fingerprint on another storefront: the runner needs two, so it is refused.
    await db.sql`insert into public.creator_records(org_id, creator_record_id, brand, campaign_id, storefront_fp, email_fp, record_state, lock_state,
        runner_version, created_on, source, source_digest)
      values (${org}, 'CCR-E3-26-0091', 'Synthetic brand', 'campaign-e3', ${fp('storefront-0091')}, ${email}, 'Active', 'Unlocked', 1, '2026-08-28',
        'control-runner', ${DIGEST}) on conflict do nothing`;
    await db.sql`insert into public.creator_action_log(org_id, event_key, creator_record_id, action, occurred_at, reason_code, evidence_reference, source,
        recorded_at)
      values (${org}, 'e3:identity:0134', 'CCR-E3-26-0134', 'identity_resolved', '2026-09-05T06:41:00Z', 'storefront', null, 'mcp', '2026-09-05T06:41:00Z'),
        (${org}, 'e3:msg:0134:2', 'CCR-E3-26-0134', 'message_sent_by_hand', '2026-09-07T06:38:00Z', null, 'ev:thread-e3-0134-2', 'mcp', '2026-09-07T06:40:00Z')
      on conflict do nothing`;
    await db.sql`insert into public.creator_action_log(org_id, event_key, creator_record_id, action, occurred_at, reservation_id, asin, reason_code,
        record_version, source, recorded_at)
      values (${org}, 'e3:registry:0134:v2', 'CCR-E3-26-0134', 'mcf_reservation_cancelled', null, 'MCFR-LEGACY-0A1B2C3D4E5F', 'B0D7Q1V8LM',
        'expired_before_submit', 2, 'control-runner', '2026-09-04T06:14:00Z') on conflict do nothing`;
    await db.sql`insert into public.creator_import_runs(org_id, started_at, finished_at, status, files, counts, source)
      values (${org}, clock_timestamp(), clock_timestamp(), 'succeeded', '{registry}', ${COUNTS}::jsonb, 'control-runner')`;

    await signIn(page, 'admin');
    await page.goto('/creators/records/CCR-E3-26-0134');
    const main = page.getByTestId('creator-record');
    await expect(main.getByRole('heading', { level: 1 })).toContainText('Creator record CCR-E3-26-0134');
    await expect(main.locator('[data-status="run-by-hand"]')).toHaveText('Run by hand');
    await expect(page.getByTestId('identity-rung')).toHaveAttribute('data-rung', 'storefront');
    await expect(page.getByTestId('identity-rung')).toContainText('Rung 1: the storefront fingerprint matched');
    await expect(page.getByTestId('refused-candidate')).toHaveCount(1);
    await expect(page.getByTestId('refused-candidate')).toHaveAttribute('data-rule', 'one_contact_fingerprint');
    await expect(page.getByTestId('refused-candidate')).toContainText('CCR-E3-26-0091');
    await expect(page.getByTestId('refused-candidate')).toContainText('the runner needs two to match');
    await expect(page.getByTestId('matching-record')).toHaveCount(0);
    await expect(page.locator('[data-testid="record-qualification"] [data-check]')).toHaveCount(10);
    await expect(page.locator('[data-testid="record-qualification"] [data-check][data-passed="true"]')).toHaveCount(8);
    await expect(page.getByTestId('score-agreement')).toHaveAttribute('data-agreement', 'disagrees');
    await expect(page.getByTestId('score-agreement')).toContainText('The tracker says 10 / 10');
    await expect(page.getByTestId('score-agreement')).toContainText('the runner computes 8 / 10');
    const events = page.getByTestId('record-event');
    await expect(events).toHaveCount(3);
    await expect(events.nth(0)).toHaveAttribute('data-action', 'message_sent_by_hand');
    await expect(events.nth(0)).toContainText('ev:thread-e3-0134-2');
    await expect(events.nth(1)).toHaveAttribute('data-action', 'identity_resolved');
    await expect(events.nth(2)).toHaveAttribute('data-action', 'mcf_reservation_cancelled');
    await expect(events.nth(2).locator('[data-time="not-recorded"]')).toHaveText('time not recorded');
    const html = await page.content();
    for (const value of [fp('storefront-0134'), fp('thread-0134'), email]) expect(html).not.toContain(value);
    await capture(page, testInfo, 'creators-record');

    await page.goto('/creators/records/CCR-E3-26-9999');
    await expect(page.locator('[data-creator-state="record-missing"]')).toContainText('No creator record CCR-E3-26-9999 is registered');

    await page.context().clearCookies();
    await signIn(page, 'viewer');
    await page.goto('/creators/records/CCR-E3-26-0134');
    await expect(page.locator('[data-creator-state="gated"]')).toContainText('Owners, admins and analysts only');
    await expect(page.getByTestId('record-event')).toHaveCount(0);
  } finally {
    await db.close();
  }
});
