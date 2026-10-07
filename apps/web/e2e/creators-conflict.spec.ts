/**
 * `/creators/conflicts/[id]` against a live authenticated Next process: two
 * records on one storefront, both locked in Conflict, every action disabled with
 * the reason; the record page links to it, and a record that is not in Conflict
 * says so. Synthetic rows only; no queue rows are written, so the queue spec is
 * unaffected.
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

test('creator conflict: two records, one storefront, and nothing here may act', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 1024 });
  const state = await readState();
  const db = createDb({ connectionString: state.connectionString, max: 1 });
  try {
    const org = state.orgId;
    const storefront = fp('storefront-shared-0117');
    const record = (id: string, lock: string, store: string, verified: string | null) => db.sql`
      insert into public.creator_records(org_id, creator_record_id, brand, campaign_id, storefront_fp, thread_fp, record_state, lock_state, runner_version,
        created_on, last_verified_on, source, source_digest)
      values (${org}, ${id}, 'Synthetic brand', 'campaign-e3c', ${store}, ${fp(`thread-${id}`)}, 'Active', ${lock}, 2, '2026-08-20', ${verified},
        'control-runner', ${DIGEST}) on conflict do nothing`;
    await record('CCR-E3-26-0117', 'Conflict', storefront, '2026-08-31');
    await record('CCR-E3-26-0203', 'Conflict', storefront, '2026-09-04');
    await record('CCR-E3-26-0150', 'Unlocked', fp('storefront-0150'), null);
    await db.sql`insert into public.creator_action_log(org_id, event_key, creator_record_id, action, occurred_at, reason_code, record_version,
        related_record_ids, source, recorded_at)
      values (${org}, 'e3c:registry:0117:conflict', 'CCR-E3-26-0117', 'identity_conflict_locked', null, 'identity_conflict', 2, '{CCR-E3-26-0203}'::text[],
        'control-runner', '2026-09-04T06:14:00Z') on conflict do nothing`;
    await db.sql`insert into public.creator_import_runs(org_id, started_at, finished_at, status, files, counts, source)
      values (${org}, clock_timestamp(), clock_timestamp(), 'succeeded', '{registry}', ${COUNTS}::jsonb, 'control-runner')`;

    await signIn(page, 'admin');
    await page.goto('/creators/records/CCR-E3-26-0117');
    await expect(page.getByTestId('conflict-banner')).toContainText('Locked in Conflict.');
    await expect(page.getByTestId('matching-record')).toHaveCount(1);
    await page.getByTestId('conflict-banner').getByRole('link', { name: 'Open the conflict' }).click();
    await page.waitForURL((url) => url.pathname === '/creators/conflicts/CCR-E3-26-0117');

    const main = page.getByTestId('creator-conflict');
    await expect(main.locator('[data-status="run-by-hand"]')).toHaveText('Run by hand');
    await expect(page.getByTestId('conflict-reason')).toContainText('Locked in Conflict: nothing here may act until the identity is resolved in the registry.');
    await expect(page.getByTestId('conflict-record')).toHaveCount(2);
    await expect(page.getByTestId('conflict-record').nth(0)).toHaveAttribute('data-record', 'CCR-E3-26-0117');
    await expect(page.getByTestId('conflict-record').nth(1)).toHaveAttribute('data-record', 'CCR-E3-26-0203');
    await expect(page.locator('[data-shared="storefront"]')).toHaveCount(2);
    await expect(page.getByTestId('locked-since')).toHaveText(/^Locked since 31 Aug 2026$/);
    const actions = page.getByTestId('locked-actions').getByRole('button');
    await expect(actions).toHaveCount(4);
    for (let index = 0; index < 4; index++) await expect(actions.nth(index)).toBeDisabled();
    await expect(page.getByTestId('disabled-reason')).toHaveText('Locked in Conflict: nothing here may act until the identity is resolved in the registry.');
    await expect(page.getByTestId('identity-event')).toHaveCount(1);
    await expect(page.getByTestId('identity-event').locator('[data-time="not-recorded"]')).toHaveText('time not recorded');
    expect(await page.content()).not.toContain(storefront);
    await capture(page, testInfo, 'creators-conflict');

    await page.goto('/creators/conflicts/CCR-E3-26-0150');
    await expect(page.locator('[data-creator-state="not-in-conflict"]')).toContainText('This record is not in Conflict');
    await expect(page.getByTestId('record-link')).toHaveAttribute('href', '/creators/records/CCR-E3-26-0150');
    await expect(page.getByTestId('conflict-record')).toHaveCount(0);

    await page.context().clearCookies();
    await signIn(page, 'viewer');
    await page.goto('/creators/conflicts/CCR-E3-26-0117');
    await expect(page.locator('[data-creator-state="gated"]')).toContainText('Owners, admins and analysts only');
  } finally {
    await db.close();
  }
});
