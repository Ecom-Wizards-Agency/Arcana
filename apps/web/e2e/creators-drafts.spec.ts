/**
 * `/creators/drafts` against a live authenticated Next process: an analyst
 * reads the day's drafts with every control disabled; an admin approves one
 * draft, which moves it and appends exactly one draft_approved entry and sends
 * nothing, then marks it sent by hand; a Conflict-locked record's draft cannot
 * be approved; a viewer is kept out. Synthetic rows only.
 */
import { createHash } from 'node:crypto';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createDb } from '@wizard-ads/db';
import { signIn } from './support/auth';
import { readState, USERS } from './support/fixture';

const COUNTS = '{"records":null,"action_log":null,"queue_items":null,"sweep_runs":null,"sample_shipments":null}';
const DIGEST = '0'.repeat(64);
const fp = (label: string) => createHash('sha256').update(`synthetic:e2e:${label}`).digest('hex');

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}-1440x1024.png`);
  await page.screenshot({ path, animations: 'disabled', style: 'nextjs-portal { display: none; }', fullPage: true });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

test('creator replies: analysts read, an admin approves one thread at a time, and nothing is sent', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 1024 });
  const state = await readState();
  const db = createDb({ connectionString: state.connectionString, max: 1 });
  try {
    const org = state.orgId;
    const record = (id: string, lock: string) => db.sql`
      insert into public.creator_records(org_id, creator_record_id, brand, campaign_id, thread_fp, record_state, lock_state, runner_version, created_on,
        source, source_digest)
      values (${org}, ${id}, 'Synthetic brand', 'campaign-e3d', ${fp(`thread-${id}`)}, 'Active', ${lock}, 1, '2026-09-01', 'control-runner', ${DIGEST})
      on conflict do nothing`;
    await record('CCR-E3-26-0301', 'Unlocked');
    // Submitted while unlocked, locked afterwards: a Conflict record takes no new draft.
    await record('CCR-E3-26-0302', 'Unlocked');
    const submit = async (id: string, body: string) => {
      const [row] = await db.sql<{ id: string }[]>`insert into public.creator_drafts(org_id, creator_record_id, thread_fp, template_key, body, draft_date,
          submission_digest, created_by, source, status_source)
        values (${org}, ${id}, ${fp(`thread-${id}`)}, 'first_base_verification', ${body}, '2026-09-09', ${fp(`draft-${id}`)}, ${USERS.admin}, 'mcp', 'mcp')
        returning id`;
      return row!.id;
    };
    const open = await submit('CCR-E3-26-0301', 'Hi {first name}, synthetic verification follow-up for thread one.');
    const locked = await submit('CCR-E3-26-0302', 'Hi {first name}, synthetic verification follow-up for thread two.');
    await db.sql`update public.creator_records set lock_state = 'Conflict' where org_id = ${org} and creator_record_id = 'CCR-E3-26-0302'`;
    await db.sql`insert into public.creator_import_runs(org_id, started_at, finished_at, status, files, counts, source)
      values (${org}, clock_timestamp(), clock_timestamp(), 'succeeded', '{registry}', ${COUNTS}::jsonb, 'control-runner')`;
    const approvals = async () => (await db.sql<{ n: number }[]>`select count(*)::int as n from public.creator_action_log
      where org_id = ${org} and draft_id = ${open}::uuid and action = 'draft_approved'`)[0]!.n;

    await signIn(page, 'analyst');
    await page.goto('/creators/drafts');
    const main = page.getByTestId('creator-drafts');
    await expect(main.locator('[data-status="run-by-hand"]')).toHaveText('Run by hand');
    await expect(page.getByTestId('sends-nothing')).toContainText('Approving a draft sends nothing.');
    await expect(page.getByTestId('draft-thread')).toHaveCount(2);
    await expect(page.getByTestId('draft')).toHaveCount(2);
    await expect(page.getByTestId('analyst-note')).toHaveText('Owners and admins approve. You can read the drafts.');
    const analystButtons = main.getByRole('button');
    await expect(analystButtons).toHaveCount(4);
    for (let index = 0; index < 4; index++) await expect(analystButtons.nth(index)).toBeDisabled();
    expect(await approvals()).toBe(0);

    await page.context().clearCookies();
    await signIn(page, 'admin');
    await page.goto('/creators/drafts');
    const thread = (id: string) => page.getByTestId('draft-thread').filter({ hasText: id });
    await expect(thread('CCR-E3-26-0302').locator('[data-move="approved"]')).toBeDisabled();
    await expect(thread('CCR-E3-26-0302').getByTestId('draft-disabled-reason')).toHaveText(
      'Locked in Conflict: nothing may be approved or sent until the identity is resolved in the registry.');
    await expect(thread('CCR-E3-26-0301')).toHaveAttribute('data-thread', `${fp('thread-CCR-E3-26-0301').slice(0, 8)}…`);
    await expect(thread('CCR-E3-26-0301').getByTestId('draft-body')).toHaveText('Hi {first name}, synthetic verification follow-up for thread one.');
    await expect(thread('CCR-E3-26-0301')).toContainText('First-base verification after background check');
    await capture(page, testInfo, 'creators-drafts');

    await thread('CCR-E3-26-0301').locator('[data-move="approved"]').click();
    await expect(thread('CCR-E3-26-0301').getByTestId('draft-status')).toHaveAttribute('data-status', 'approved');
    await expect(thread('CCR-E3-26-0301').getByTestId('draft-status')).toHaveText('Approved: to send by hand');
    await expect(thread('CCR-E3-26-0301').getByTestId('draft-meta')).toContainText('by you');
    await expect.poll(approvals).toBe(1);
    const [stored] = await db.sql<{ status: string; approved_by: string | null }[]>`select status, approved_by from public.creator_drafts where id = ${open}::uuid`;
    expect(stored).toEqual({ status: 'approved', approved_by: USERS.admin });
    const [lockedRow] = await db.sql<{ status: string }[]>`select status from public.creator_drafts where id = ${locked}::uuid`;
    expect(lockedRow!.status).toBe('draft');
    await capture(page, testInfo, 'creators-drafts-approved');

    await page.reload();
    await thread('CCR-E3-26-0301').locator('[data-move="sent_by_hand"]').click();
    await expect(thread('CCR-E3-26-0301').getByTestId('draft-status')).toHaveAttribute('data-status', 'sent_by_hand');
    await expect.poll(async () => (await db.sql<{ n: number }[]>`select count(*)::int as n from public.creator_action_log
      where org_id = ${org} and draft_id = ${open}::uuid and action = 'draft_sent_by_hand'`)[0]!.n).toBe(1);
    expect(await approvals()).toBe(1);

    // The server refuses what the screen disables: approving the Conflict-locked draft is refused and nothing moves.
    const refused = await page.evaluate(async (id) => {
      const response = await fetch(`/creators/drafts/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: 'approved' }) });
      return { status: response.status, body: await response.json() as { code?: string } };
    }, locked);
    expect(refused).toEqual({ status: 409, body: expect.objectContaining({ code: 'transition_refused' }) });
    const [stillLocked] = await db.sql<{ status: string }[]>`select status from public.creator_drafts where id = ${locked}::uuid`;
    expect(stillLocked!.status).toBe('draft');

    await page.context().clearCookies();
    await signIn(page, 'viewer');
    await page.goto('/creators/drafts');
    await expect(page.locator('[data-creator-state="gated"]')).toContainText('Owners, admins and analysts only');
    await expect(page.getByTestId('draft')).toHaveCount(0);
  } finally {
    await db.close();
  }
});
