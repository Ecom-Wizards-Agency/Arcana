/** `/creators/sweep` live: the nine counts, the completion equation and the unmatched threads by fingerprint. Synthetic rows only. */
import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { createDb } from '@wizard-ads/db';
import { signIn } from './support/auth';
import { readState } from './support/fixture';

const COUNTS = '{"records":null,"action_log":null,"queue_items":null,"sample_shipments":null,'
  + '"sweep_runs":{"read":1,"valid":1,"invalid":0,"inserted":1,"updated":0,"unchanged":0,"removed":0}}';
const fp = (label: string) => createHash('sha256').update(`synthetic:${label}`).digest('hex');

test('inbox sweep: how the thread list was drained and what it could not match', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 1024 });
  const state = await readState();
  const db = createDb({ connectionString: state.connectionString, max: 1 });
  try {
    const threads = [1, 2, 3].map((index) => ({ threadKey: fp(`e2e-thread-${index}`), amazonTimestamp: `2026-09-09T0${index}:15:00.000Z`,
      outcome: 'unmatched', reason: 'multiple_active_records_match' }));
    await db.sql`insert into public.creator_sweep_runs(org_id, run_id, run_date, completed_at, mounted, opened, changed, messages_examined, messages_sent,
        no_action_acknowledgements, held_or_escalated, archived_spam, unmatched, outcomes, unresolved_threads, evidence_reference, source, source_digest)
      values (${state.orgId}, 'e2e-sweep-latest', '2026-09-26', '2026-09-26T06:12:00Z', 412, 412, 37, 96, 0, 359, 9, 5, 7,
        '{"unchanged":359,"actioned":37,"held":6,"escalated":3,"unmatched":7,"unopened":0,"unclassified":0}'::jsonb, ${JSON.stringify(threads)}::jsonb,
        'ev:sweep-e2e', 'control-runner', ${'0'.repeat(64)}) on conflict do nothing`;
    await db.sql`insert into public.creator_import_runs(org_id, started_at, finished_at, status, files, counts, source)
      values (${state.orgId}, clock_timestamp(), clock_timestamp(), 'succeeded', '{sweep_checkpoint}', ${COUNTS}::jsonb, 'control-runner')`;
    const [stored] = await db.sql<{ reconciled: boolean }[]>`select reconciled from public.creator_sweep_runs where org_id = ${state.orgId} and run_id = 'e2e-sweep-latest'`;
    expect(stored!.reconciled).toBe(false);

    await signIn(page, 'analyst');
    await page.goto('/creators/sweep');
    const main = page.getByTestId('creator-sweep');
    await expect(main.getByRole('heading', { name: /Inbox sweep/ })).toBeVisible();
    await expect(main.locator('[data-status="run-by-hand"]')).toHaveText('Run by hand');
    await expect(page.getByTestId('sweep-verdict')).toContainText('This sweep did not reconcile.');
    await expect(page.getByTestId('sweep-equation')).toContainText('412 enumerated = 359 no-action + 37 changed + 9 held or escalated + 7 unmatched.');
    await expect(page.getByTestId('sweep-count')).toHaveCount(9);
    await expect(page.getByTestId('unmatched-thread')).toHaveCount(3);
    await expect(page.getByTestId('unmatched-summary')).toContainText('3 of 7 listed by thread fingerprint');
    await expect(page.getByTestId('unmatched-thread').first()).toContainText(threads[0]!.threadKey.slice(0, 12));
    const path = testInfo.outputPath('creators-sweep-1440x1024.png');
    await page.screenshot({ path, animations: 'disabled', style: 'nextjs-portal { display: none; }' });
    await testInfo.attach('creators-sweep', { path, contentType: 'image/png' });
  } finally {
    await db.close();
  }
});
