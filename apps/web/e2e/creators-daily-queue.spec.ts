/**
 * `/creators` against a live authenticated Next process: the day's work over a
 * sweep that did not reconcile, the refusal after a failed read, a day worked
 * to zero, and a viewer kept out. Rows are synthetic and written as the import
 * would write them; nothing here reads a tracker or calls Amazon.
 */
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createDb } from '@wizard-ads/db';
import { signIn } from './support/auth';
import { readState } from './support/fixture';

const COUNTS = '{"records":null,"action_log":null,"queue_items":null,"sweep_runs":null,"sample_shipments":null}';
/** An import that read a sweep checkpoint: the strip shows a sweep only when the latest import supplied one. */
const WITH_SWEEP = '{"records":null,"action_log":null,"queue_items":null,"sample_shipments":null,'
  + '"sweep_runs":{"read":1,"valid":1,"invalid":0,"inserted":1,"updated":0,"unchanged":0,"removed":0}}';
const DIGEST = '0'.repeat(64);

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}-1440x1024.png`);
  await page.screenshot({ path, animations: 'disabled', style: 'nextjs-portal { display: none; }' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

test('creator queue: the day\'s work, the refusal, worked to zero, and viewers kept out', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 1024 });
  const state = await readState();
  const db = createDb({ connectionString: state.connectionString, max: 1 });
  try {
    const org = state.orgId;
    const records = [['CCR-E2-26-0117', 'Conflict'], ['CCR-E2-26-0203', 'Conflict'], ['CCR-E2-26-0134', 'Unlocked'], ['CCR-E2-26-0072', 'Locked for MCF']];
    for (const [id, lock] of records) {
      await db.sql`insert into public.creator_records(org_id, creator_record_id, brand, campaign_id, record_state, lock_state, runner_version, created_on, source, source_digest)
        values (${org}, ${id!}, 'Synthetic brand', 'campaign-e2e', 'Active', ${lock!}, 1, '2026-09-01', 'control-runner', ${DIGEST}) on conflict do nothing`;
    }
    // The tracker typed 10 where the runner computes 8: the score that disagrees when the row is opened.
    await db.sql`update public.creator_records set tracker_score = 10, tracker_scored_on = '2026-09-09'
      where org_id = ${org} and creator_record_id = 'CCR-E2-26-0134'`;
    // A record the run does not name, under a label outside the tracker's dropdown.
    await db.sql`insert into public.creator_records(org_id, creator_record_id, brand, campaign_id, record_state, lock_state, runner_version, created_on,
        status, computed_score, missing_checks, qualified_on, source, source_digest)
      values (${org}, 'CCR-E2-26-0400', 'Synthetic brand', 'campaign-e2e', 'Active', 'Unlocked', 1, '2026-09-01', 'Awaiting Sample', 10, '{}'::text[],
        '2026-09-08', 'control-runner', ${DIGEST}) on conflict do nothing`;
    // Every row is a shape creator_control.py queue_item emits.
    const item = (id: string | null, action: string, gate: string, stateName: string, score: number, missing: string[], status: string, reason: string) => db.sql`
      insert into public.creator_daily_queue(org_id, run_date, queue_id, occurrence, creator_record_id, brand, campaign_tab, current_status, computed_score,
        missing_checks, due_date, action_type, gate_result, queue_state, reason, source, source_digest)
      values (${org}, '2026-09-09', ${`20260909-${id ?? 'UNRESOLVED'}`}, 1, ${id}, 'Synthetic brand', 'Synthetic tab', ${status}, ${score}, ${missing}::text[],
        '2026-09-09', ${action}, ${gate}, ${stateName}, ${reason}, 'control-runner', ${DIGEST}) on conflict do nothing`;
    await item(null, 'IDENTITY_RESOLUTION', 'BLOCKED', 'Escalated', 10, [], '', 'missing_creator_record_id');
    await item('CCR-E2-26-0117', 'BACKGROUND_CHECK', 'HOLD', 'Queued', 10, [], 'New Inquiry', 'new_inquiry_requires_visible_evidence');
    await item('CCR-E2-26-0203', 'SEND_TAILORED_VERIFICATION_FOLLOW_UP', 'PENDING_APPROVAL', 'Queued', 9, ['complete_fulfillment_details'], 'First-Base Pass',
      'message_send_requires_current_approval;missing_complete_fulfillment_details');
    await item('CCR-E2-26-0134', 'RECONCILE_QUALIFICATION', 'BLOCKED', 'Escalated', 8, ['recent_post_verified', 'performance_or_revenue'], 'Verification Confirmed', 'status_score_drift');
    await item('CCR-E2-26-0072', 'MCF_PREFLIGHT', 'HOLD', 'Queued', 10, [], 'Approved for Sample', 'paid_order_requires_preflight_and_authorized_executor');
    await db.sql`insert into public.creator_sweep_runs(org_id, run_id, run_date, completed_at, mounted, opened, changed, messages_examined, messages_sent,
        no_action_acknowledgements, held_or_escalated, archived_spam, unmatched, evidence_reference, source, source_digest)
      values (${org}, 'e2e-sweep-20260909', '2026-09-09', '2026-09-09T06:12:00Z', 412, 412, 37, 96, 0, 359, 9, 5, 7, 'ev:sweep-0909', 'control-runner', ${DIGEST})
      on conflict do nothing`;
    await db.sql`insert into public.creator_import_runs(org_id, started_at, finished_at, status, files, queue_run_date, counts, source)
      values (${org}, clock_timestamp(), clock_timestamp(), 'succeeded', '{registry,queue,sweep_checkpoint}', '2026-09-09', ${WITH_SWEEP}::jsonb, 'control-runner')`;

    await signIn(page, 'admin');
    await page.goto('/creators');
    const main = page.getByTestId('creator-queue');
    await expect(main.getByRole('heading', { name: /Creator queue/ })).toBeVisible();
    await expect(main.locator('[data-status="run-by-hand"]')).toHaveText('Run by hand');
    await expect(page.getByTestId('tile-total').locator('strong')).toHaveText('5');
    await expect(page.getByTestId('tile-approval').locator('strong')).toHaveText('1');
    await expect(page.getByTestId('tile-held').locator('strong')).toHaveText('4');
    await expect(page.getByTestId('tile-locked').locator('strong')).toHaveText('2');
    await expect(page.getByTestId('queue-group')).toHaveCount(5);
    await expect(page.getByTestId('queue-row')).toHaveCount(5);
    await expect(page.getByTestId('sweep-strip')).toContainText('The last sweep did not reconcile');
    await expect(page.getByTestId('sweep-strip').locator('[data-sweep-count="unmatched"]')).toHaveText('7 unmatched');
    await expect(page.getByTestId('queue-row').filter({ hasText: 'CCR-E2-26-0134' })).toContainText('8 / 10');
    await expect(page.locator('[data-lock="Conflict"]')).toHaveCount(2);
    const nav = page.locator('details.wa-navgroup').filter({ hasText: 'CREATORS' });
    await expect(nav.getByRole('link', { name: 'Daily queue' })).toHaveAttribute('href', '/creators');
    await expect(nav.getByRole('link', { name: 'Inbox sweep' })).toHaveAttribute('href', '/creators/sweep');
    await expect(nav.getByRole('link', { name: 'Sample shipments' })).toHaveAttribute('href', '/creators/samples');
    // The row opened in place (444:301) and the records that produced no action (444:2).
    const opened = page.locator('[data-testid="queue-row-open"][data-record="CCR-E2-26-0134"]');
    await opened.locator('summary').click();
    await expect(opened.locator('[data-check]')).toHaveCount(10);
    await expect(opened.locator('[data-check][data-passed="false"]')).toHaveCount(2);
    await expect(opened.getByTestId('score-agreement')).toHaveAttribute('data-agreement', 'disagrees');
    await expect(opened.getByTestId('score-agreement')).toContainText('the runner computes 8 / 10');
    await expect(opened.getByTestId('open-record')).toHaveAttribute('href', '/creators/records/CCR-E2-26-0134');
    await expect(page.locator('[data-testid="queue-row-open"][data-record="CCR-E2-26-0203"]').getByTestId('open-drafts')).toHaveAttribute('href', '/creators/drafts');
    await expect(page.getByTestId('idle-refused')).toHaveText('Awaiting Sample: 1 record');
    await capture(page, testInfo, 'creators-queue');

    await db.sql`insert into public.creator_import_runs(org_id, started_at, finished_at, status, failure, failed_file, files, counts, source)
      values (${org}, clock_timestamp(), clock_timestamp(), 'failed', 'file_shape_invalid', 'queue', '{queue}', ${COUNTS}::jsonb, 'control-runner')`;
    await page.reload();
    await expect(page.locator('[data-creator-state="refused"]')).toContainText('Nothing was read');
    await expect(page.getByTestId('queue-row')).toHaveCount(0);
    await capture(page, testInfo, 'creators-queue-refused');

    await db.sql`insert into public.creator_import_runs(org_id, started_at, finished_at, status, files, queue_run_date, counts, source)
      values (${org}, clock_timestamp(), clock_timestamp(), 'succeeded', '{queue}', '2026-09-10', ${COUNTS}::jsonb, 'control-runner')`;
    await page.reload();
    await expect(page.locator('[data-creator-state="worked-to-zero"]')).toContainText('Worked to zero');
    const [registry] = await db.sql<{ n: number }[]>`select count(*)::int as n from public.creator_records where org_id = ${org}`;
    await expect(page.locator('[data-creator-state="worked-to-zero"]')).toContainText(`${registry!.n} records on the registry did not move`);
    await capture(page, testInfo, 'creators-queue-worked-to-zero');

    await page.context().clearCookies();
    await signIn(page, 'viewer');
    await page.goto('/creators');
    await expect(page.locator('[data-creator-state="gated"]')).toContainText('Owners, admins and analysts only');
    await expect(page.getByTestId('queue-row')).toHaveCount(0);
  } finally {
    await db.close();
  }
});
