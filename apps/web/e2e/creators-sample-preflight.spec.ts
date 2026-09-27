/**
 * `/creators/samples/[key]/preflight` live: a pass with a current preview, a
 * pre-flight held at check seven because the SKU is merchant-fulfilled, and a
 * pass whose preview expired. Synthetic rows only; no Amazon call is made and
 * no creator is named.
 */
import { createHash } from 'node:crypto';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { creatorPreflightChecks, CreatorPreflightCheck } from '@wizard-ads/shared';
import { createDb } from '@wizard-ads/db';
import { signIn } from './support/auth';
import { readState } from './support/fixture';

const COUNTS = '{"records":null,"action_log":null,"queue_items":null,"sweep_runs":null,"sample_shipments":null,"preflights":null}';
const DIGEST = '0'.repeat(64);
const BINDING = createHash('sha256').update('synthetic:e2e:recipient-binding').digest('hex');

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}-1440x1024.png`);
  await page.screenshot({ path, animations: 'disabled', style: 'nextjs-portal { display: none; }', fullPage: true });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

interface Run { record: string; asin: string; sku: string; errors: string[]; readAt: string; previewReadAt: string | null; previewValidUntil: string | null;
  channel: string; mcf: boolean; units: number }

function detail(run: Run) {
  const reads = CreatorPreflightCheck.options.map((check) => ({ check, readAt: run.readAt, evidenceReference: `ev:e5-${check}` }));
  return {
    computedScore: 10, checks: creatorPreflightChecks(run.errors, reads), sku: run.sku, campaignId: 'campaign-e5', productTitle: 'Synthetic roller',
    trackerSourceRef: 'tracker row 5', quantity: 1, feeCents: 620, feeCapCents: 800,
    inventory: { asin: run.asin, sku: run.sku, fulfillmentChannel: run.channel, mcfFulfillable: run.mcf, fulfillableQuantity: run.units,
      checkedAt: run.readAt, evidenceReference: 'ev:e5-inventory' },
    preview: run.previewReadAt === null ? null : { operation: 'getFulfillmentPreview', readAt: run.previewReadAt, validUntil: run.previewValidUntil,
      isFulfillable: true, feeCents: 620, currency: 'EUR', constraints: [] },
  };
}

test('sample pre-flight: a pass, a hold at check seven, and a pass whose preview expired', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 1024 });
  const state = await readState();
  const db = createDb({ connectionString: state.connectionString, max: 1 });
  try {
    const org = state.orgId;
    const now = Date.now();
    const recent = new Date(now - 60_000).toISOString();
    const runs: (Run & { runId: string })[] = [
      { runId: 'e5-pass-0088', record: 'CCR-E5-26-0088', asin: 'B0D9K3M2QP', sku: 'SW-E5-05-FBA', errors: [], readAt: recent, previewReadAt: recent,
        previewValidUntil: new Date(now + 2 * 60 * 60_000).toISOString(), channel: 'AFN', mcf: true, units: 37 },
      { runId: 'e5-hold-0151', record: 'CCR-E5-26-0151', asin: 'B0D7Q1V8LM', sku: 'SW-E5-03-FBM', errors: ['selected_sku_not_mcf_fulfillable'],
        readAt: '2026-09-09T06:31:11Z', previewReadAt: null, previewValidUntil: null, channel: 'MFN', mcf: false, units: 0 },
      { runId: 'e5-stale-0090', record: 'CCR-E5-26-0090', asin: 'B0D9K3M2QP', sku: 'SW-E5-05-FBA', errors: [], readAt: '2026-09-09T06:33:17Z',
        previewReadAt: '2026-09-09T06:33:17Z', previewValidUntil: null, channel: 'AFN', mcf: true, units: 37 },
    ];
    for (const run of runs) {
      await db.sql`insert into public.creator_records(org_id, creator_record_id, brand, campaign_id, storefront_fp, record_state, lock_state, runner_version,
          created_on, source, source_digest)
        values (${org}, ${run.record}, 'Synthetic brand', 'campaign-e5', ${createHash('sha256').update(`synthetic:e5:${run.record}`).digest('hex')},
          'Active', 'Unlocked', 1, '2026-09-01', 'control-runner', ${DIGEST}) on conflict do nothing`;
      const passed = run.errors.length === 0;
      await db.sql`insert into public.creator_sample_preflights(org_id, run_id, command, creator_record_id, asin, result, errors, required_next_state,
          recipient_binding_fp, detail, preview_read_at, preview_valid_until, inventory_checked_at, started_at, completed_at, source, source_digest)
        values (${org}, ${run.runId}, 'preflight', ${run.record}, ${run.asin}, ${passed ? 'PASS' : 'HOLD'}, ${run.errors}::text[],
          ${passed ? 'Locked for MCF' : 'Conflict or Held'}, ${BINDING}, ${JSON.stringify(detail(run))}::jsonb, ${run.previewReadAt},
          ${run.previewValidUntil}, ${run.readAt}, ${run.readAt}, ${run.readAt}, 'control-runner', ${DIGEST}) on conflict do nothing`;
    }
    await db.sql`insert into public.creator_import_runs(org_id, started_at, finished_at, status, files, counts, source)
      values (${org}, clock_timestamp(), clock_timestamp(), 'succeeded', '{registry,preflight_results}', ${COUNTS}::jsonb, 'control-runner')`;
    const key = (record: string, asin: string) => `CCS-${createHash('sha256').update(`${org}|${record}|${asin}`).digest('hex').slice(0, 32)}`;

    await signIn(page, 'admin');
    await page.goto(`/creators/samples/${key('CCR-E5-26-0088', 'B0D9K3M2QP')}/preflight`);
    const main = page.getByTestId('creator-preflight');
    await expect(main.getByRole('heading', { level: 1 })).toContainText('Sample pre-flight');
    await expect(main.locator('[data-status="run-by-hand"]')).toHaveText('Run by hand');
    await expect(page.getByTestId('preflight-pass')).toContainText('All eight checks held in run e5-pass-0088');
    await expect(page.getByTestId('preflight-check')).toHaveCount(8);
    await expect(page.locator('[data-testid="preflight-check"][data-outcome="pass"]')).toHaveCount(8);
    await expect(page.getByTestId('what-this-will-do').getByTestId('order-key')).toHaveText(key('CCR-E5-26-0088', 'B0D9K3M2QP'));
    await expect(page.getByTestId('recipient')).toHaveAttribute('data-bound', 'true');
    await expect(page.getByTestId('place-order')).toBeDisabled();
    await expect(page.getByTestId('place-order-note')).toContainText('Ordering is not built in this round.');
    await expect(page.locator('main button:not([disabled])')).toHaveCount(0);
    await capture(page, testInfo, 'creators-preflight-pass');

    await page.goto(`/creators/samples/${key('CCR-E5-26-0151', 'B0D7Q1V8LM')}/preflight`);
    await expect(page.getByTestId('preflight-held')).toContainText('Held at check seven: selected_sku_not_mcf_fulfillable');
    await expect(page.locator('[data-testid="preflight-check"][data-outcome="pass"]')).toHaveCount(7);
    await expect(page.locator('[data-testid="preflight-check"][data-check="fulfillable_stock"]')).toHaveAttribute('data-outcome', 'hold');
    await expect(page.getByTestId('held-units')).toHaveText('0');
    await expect(page.getByTestId('listing-trap')).toContainText('An active listing is not fulfillable stock.');
    await expect(page.getByTestId('what-this-will-do')).toHaveCount(0);
    await capture(page, testInfo, 'creators-preflight-held');

    await page.goto(`/creators/samples/${key('CCR-E5-26-0090', 'B0D9K3M2QP')}/preflight`);
    await expect(page.getByTestId('preflight-stale')).toContainText('The preview expired, so nothing was sent.');
    await expect(page.getByTestId('preflight-stale')).toContainText('a new pre-flight is needed');
    await expect(page.getByTestId('preflight-pass')).toHaveCount(0);

    await page.goto(`/creators/samples/${key('CCR-E5-26-0999', 'B0D9K3M2QP')}/preflight`);
    await expect(page.locator('[data-creator-state="nothing-held"]')).toBeVisible();
    await page.goto('/creators/samples/not-a-key/preflight');
    await expect(page.locator('[data-creator-state="key-missing"]')).toContainText('This address does not name a sample order key.');
  } finally {
    await db.close();
  }
});
