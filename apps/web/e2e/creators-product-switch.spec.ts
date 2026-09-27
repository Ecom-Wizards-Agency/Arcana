/**
 * `/creators/samples/[key]/product-switch` against a live authenticated Next
 * process: the original lane's pre-flight held at the stock check, and three
 * alternates checked in live stock, one offered, one held and one where the
 * sources disagree. The key in the path is the original lane's derived order
 * key, computed here from its definition. Synthetic rows only; no Amazon call
 * is made and nothing is ordered.
 */
import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { creatorPreflightChecks } from '@wizard-ads/shared';
import { createDb } from '@wizard-ads/db';
import { signIn } from './support/auth';
import { readState } from './support/fixture';

const COUNTS = '{"records":null,"action_log":null,"queue_items":null,"sweep_runs":null,"sample_shipments":null,"preflights":null}';
const DIGEST = '0'.repeat(64);
const RECORD = 'CCR-E7-26-0166';
const ORIGINAL = 'B0D7Q1V8LM';
const OFFERED = 'B0D9K3M2QP';
const digest = (label: string) => createHash('sha256').update(`synthetic:e2e:${label}`).digest('hex');

interface Alternate { asin: string; sku: string; channel: string; mcf: boolean; units: number; errors: string[] }
const ALTERNATES: Alternate[] = [
  { asin: OFFERED, sku: 'SW-DERMA-05-FBA', channel: 'Amazon-fulfilled', mcf: true, units: 37, errors: [] },
  { asin: 'B0D6H9YY41', sku: 'SW-DERMA-01-FBM', channel: 'merchant-fulfilled', mcf: false, units: 0,
    errors: ['selected_sku_not_fba_fulfilled', 'selected_sku_not_mcf_fulfillable', 'insufficient_mcf_fulfillable_quantity'] },
  { asin: 'B0DB4X2NRT', sku: 'SW-SERUM-02-FBA', channel: 'Amazon-fulfilled', mcf: true, units: 88,
    errors: ['alternate_asin_not_in_campaign', 'alternate_catalog_asin_mismatch'] },
];

test('product switch: why the original cannot ship, and every alternate checked in live stock', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 1024 });
  const state = await readState();
  const db = createDb({ connectionString: state.connectionString, max: 1 });
  try {
    const org = state.orgId;
    await db.sql`insert into public.creator_records(org_id, creator_record_id, brand, campaign_id, storefront_fp, record_state, lock_state, runner_version,
        created_on, status, computed_score, missing_checks, qualified_on, source, source_digest)
      values (${org}, ${RECORD}, 'Synthetic brand', 'campaign-e7', ${digest('storefront-0166')}, 'Active', 'Unlocked', 2, '2026-09-01',
        'Product Switch Pending', 10, '{}'::text[], '2026-09-08', 'control-runner', ${DIGEST}) on conflict do nothing`;

    // The original lane's sample pre-flight: HOLD at the stock check, the SKU merchant-fulfilled.
    const originalErrors = ['selected_sku_not_mcf_fulfillable'];
    const originalInventory = { asin: ORIGINAL, sku: 'SW-DERMA-03-FBM', fulfillmentChannel: 'merchant-fulfilled', mcfFulfillable: false,
      fulfillableQuantity: 0, checkedAt: '2026-09-09T06:36:00.000Z', evidenceReference: 'ev:e7-mcf-inv-17' };
    const originalDetail = {
      computedScore: 10,
      checks: creatorPreflightChecks(originalErrors, [{ check: 'fulfillable_stock', readAt: '2026-09-09T06:36:00.000Z', evidenceReference: 'ev:e7-mcf-inv-17' }]),
      sku: 'SW-DERMA-03-FBM', campaignId: 'campaign-e7', productTitle: 'Synthetic derma stamp', trackerSourceRef: 'tracker:e7-0166',
      quantity: 1, feeCents: null, feeCapCents: 800, inventory: originalInventory, preview: null,
    };
    await db.sql`insert into public.creator_sample_preflights(org_id, run_id, command, creator_record_id, asin, original_asin, result, errors,
        required_next_state, recipient_binding_fp, detail, inventory_checked_at, started_at, completed_at, source, source_digest)
      values (${org}, 'e7-preflight-0166', 'preflight', ${RECORD}, ${ORIGINAL}, null, 'HOLD', ${originalErrors}::text[], 'Conflict or Held',
        ${digest('recipient-0166')}, ${JSON.stringify(originalDetail)}::jsonb, '2026-09-09T06:36:00Z', '2026-09-09T06:35:40Z', '2026-09-09T06:36:10Z',
        'control-runner', ${digest('run-e7-preflight-0166')}) on conflict do nothing`;

    // One product-switch pre-flight per alternate, each against the original ASIN.
    for (const alternate of ALTERNATES) {
      const detail = {
        phase: 'offer', alternateSku: alternate.sku,
        inventory: { asin: alternate.asin, sku: alternate.sku, fulfillmentChannel: alternate.channel, mcfFulfillable: alternate.mcf,
          fulfillableQuantity: alternate.units, checkedAt: '2026-09-08T13:40:30.000Z', evidenceReference: `ev:e7-mcf-inv-${alternate.asin}` },
        originalUnavailableReason: 'not_mcf_fulfillable', originalBlockerEvidenceReference: 'ev:e7-mcf-inv-17',
      };
      const pass = alternate.errors.length === 0;
      await db.sql`insert into public.creator_sample_preflights(org_id, run_id, command, creator_record_id, asin, original_asin, result, errors,
          required_next_state, recipient_binding_fp, detail, inventory_checked_at, started_at, completed_at, source, source_digest)
        values (${org}, ${`e7-switch-0166-${alternate.asin}`}, 'preflight-switch', ${RECORD}, ${alternate.asin}, ${ORIGINAL}, ${pass ? 'PASS' : 'HOLD'},
          ${alternate.errors}::text[], ${pass ? 'Product Switch Pending' : 'Conflict or Held'}, null, ${JSON.stringify(detail)}::jsonb,
          '2026-09-08T13:40:30Z', '2026-09-08T13:40:00Z', '2026-09-08T13:41:00Z', 'control-runner', ${digest(`run-e7-switch-${alternate.asin}`)})
        on conflict do nothing`;
    }
    await db.sql`insert into public.creator_import_runs(org_id, started_at, finished_at, status, files, counts, source)
      values (${org}, clock_timestamp(), clock_timestamp(), 'succeeded', '{registry,preflight_results}', ${COUNTS}::jsonb, 'control-runner')`;
    const key = `CCS-${createHash('sha256').update(`${org}|${RECORD}|${ORIGINAL}`).digest('hex').slice(0, 32)}`;

    await signIn(page, 'admin');
    await page.goto(`/creators/samples/${key}/product-switch`);
    const main = page.getByTestId('creator-product-switch');
    await expect(main.getByRole('heading', { level: 1 })).toContainText('Product switch');
    await expect(main.locator('[data-status="run-by-hand"]')).toHaveText('Run by hand');
    await expect(main).toHaveAttribute('data-switch-state', 'ready');
    await expect(page.getByTestId('order-key')).toHaveText(key);
    await expect(page.getByTestId('switch-status')).toHaveText('Product Switch Pending');
    await expect(page.getByTestId('active-asin-banner')).toContainText(`${ORIGINAL} stays the active ASIN on this record.`);

    await expect(page.getByTestId('original-source')).toHaveAttribute('data-source', 'preflight');
    await expect(page.getByTestId('original-stock-check')).toHaveAttribute('data-outcome', 'hold');
    await expect(page.getByTestId('original-stock-check').locator('[data-code]')).toHaveText(['selected_sku_not_mcf_fulfillable']);
    await expect(page.getByTestId('original-inventory').locator('dd')).toHaveText([ORIGINAL, 'SW-DERMA-03-FBM', 'merchant-fulfilled', 'no', '0 units',
      /06:36 UTC · ev:e7-mcf-inv-17$/]);

    const rows = page.getByTestId('switch-candidate');
    await expect(rows).toHaveCount(3);
    await expect(page.locator('[data-testid="switch-candidate"][data-disposition="offered"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="switch-candidate"]:not([data-disposition="offered"])')).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute('data-asin', OFFERED);
    await expect(rows.nth(1)).toHaveAttribute('data-asin', 'B0D6H9YY41');
    await expect(rows.nth(1)).toHaveAttribute('data-disposition', 'held');
    await expect(rows.nth(2)).toHaveAttribute('data-asin', 'B0DB4X2NRT');
    await expect(rows.nth(2)).toHaveAttribute('data-disposition', 'disagreement');
    await expect(rows.locator('[data-units]')).toHaveText(['37 units', '0 units', '88 units']);
    await expect(rows.nth(1).locator('[data-code]')).toHaveText(ALTERNATES[1]!.errors);
    await expect(rows.nth(2).locator('[data-code]')).toHaveText(ALTERNATES[2]!.errors);
    await expect(rows.nth(0).locator('[data-code]')).toHaveCount(0);

    await expect(page.locator('[data-quote="counts"]')).toHaveText(`“Yes, ${OFFERED} works for me.”`);
    await expect(main.locator('button')).toHaveCount(1);
    await expect(main.locator('button')).toBeDisabled();
    await expect(page.getByTestId('nothing-sent')).toHaveText('Nothing was ordered, reserved or sent from Arcana.');
    await expect(page.getByTestId('switch-links').locator('a')).toHaveCount(3);
    const path = testInfo.outputPath('creators-product-switch-1440x1024.png');
    await page.screenshot({ path, animations: 'disabled', style: 'nextjs-portal { display: none; }', fullPage: true });
    await testInfo.attach('creators-product-switch', { path, contentType: 'image/png' });

    await page.goto('/creators/samples/not-a-key/product-switch');
    await expect(page.locator('[data-creator-state="key-missing"]')).toContainText('This address does not name a sample order key.');

    await page.context().clearCookies();
    await signIn(page, 'viewer');
    await page.goto(`/creators/samples/${key}/product-switch`);
    await expect(page.locator('[data-creator-state="gated"]')).toContainText('Owners, admins and analysts only');
    await expect(page.getByTestId('switch-candidate')).toHaveCount(0);
  } finally {
    await db.close();
  }
});
