/**
 * `/creators/samples` live: the derived order key has no clock and matches its
 * definition, an ambiguous submit stays locked, and a package Amazon holds with
 * no carrier scan says so. Synthetic rows only; no Amazon call is made.
 */
import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { createDb } from '@wizard-ads/db';
import { signIn } from './support/auth';
import { readState } from './support/fixture';

const COUNTS = '{"records":null,"action_log":null,"queue_items":null,"sweep_runs":null,"sample_shipments":null}';
const DIGEST = '0'.repeat(64);

test('sample shipments: derived keys, an ambiguous submit, and a package the carrier has not scanned', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 1024 });
  const state = await readState();
  const db = createDb({ connectionString: state.connectionString, max: 1 });
  try {
    const org = state.orgId;
    const packages = JSON.stringify([{ packageNumber: 1, carrierCode: 'Synthetic carrier', trackingNumber: 'SYNTHETIC-TRACK-E2E', estimatedArrivalAt: null,
      carrierStatus: null, carrierStatusReadAt: null }]);
    await db.sql`insert into public.creator_sample_shipments(org_id, creator_record_id, asin, sku, reservation_id, lane_state, runner_order_id, fee_cents,
        fee_cap_cents, reserved_at, confirmed_at, mcf_status, mcf_operation, mcf_read_at, packages, source, source_digest)
      values (${org}, 'CCR-E2-26-0088', 'B0D9K3M2QP', 'SW-DERMA-05-FBA', 'MCFR-00000000000000E8', 'Confirmed', 'synthetic-order-e2e', 620, 800,
        '2026-09-09T06:33:19Z', '2026-09-09T06:40:00Z', 'Complete', 'getFulfillmentOrder', '2026-09-09T11:02:41Z', ${packages}::jsonb, 'control-runner', ${DIGEST})
      on conflict do nothing`;
    await db.sql`insert into public.creator_sample_shipments(org_id, creator_record_id, asin, sku, reservation_id, lane_state, fee_cents, fee_cap_cents,
        verified_at, reconciliation_reason, source, source_digest)
      values (${org}, 'CCR-E2-26-0072', 'B0D9K3M2QP', 'SW-DERMA-05-FBA', 'MCFR-9F2C41AB77E0D3B5', 'Reconciliation Required', 620, 800,
        '2026-09-08T06:44:00Z', 'outcome_unknown', 'control-runner', ${DIGEST}) on conflict do nothing`;
    await db.sql`insert into public.creator_import_runs(org_id, started_at, finished_at, status, files, counts, source)
      values (${org}, clock_timestamp(), clock_timestamp(), 'succeeded', '{registry,mcf_reservations}', ${COUNTS}::jsonb, 'control-runner')`;
    const expectedKey = (record: string) => `CCS-${createHash('sha256').update(`${org}|${record}|B0D9K3M2QP`).digest('hex').slice(0, 32)}`;
    await expect(db.sql`insert into public.creator_sample_shipments(org_id, creator_record_id, asin, lane_state, reservation_id, source, source_digest)
      values (${org}, 'CCR-E2-26-0072', 'B0D9K3M2QP', 'Reserved', 'MCFR-00000000000000E9', 'web', ${DIGEST})`).rejects.toThrow(/duplicate key/);

    await signIn(page, 'admin');
    await page.goto('/creators/samples');
    const main = page.getByTestId('creator-samples');
    await expect(main.getByRole('heading', { name: /Sample shipments/ })).toBeVisible();
    await expect(main.locator('[data-status="run-by-hand"]')).toHaveText('Run by hand');
    const shipped = page.getByTestId('sample-lane').filter({ hasText: 'CCR-E2-26-0088' });
    const ambiguous = page.getByTestId('sample-lane').filter({ hasText: 'CCR-E2-26-0072' });
    await expect(shipped.getByTestId('order-key')).toHaveText(expectedKey('CCR-E2-26-0088'));
    await expect(ambiguous.getByTestId('order-key')).toHaveText(expectedKey('CCR-E2-26-0072'));
    await expect(shipped).toContainText('Amazon · getFulfillmentOrder · 11:02:41');
    await expect(shipped).toContainText('The carrier has no scan for it yet');
    await expect(ambiguous).toContainText('Reconciliation Required');
    await expect(ambiguous).toContainText('Not read from Amazon');
    await expect(page.getByTestId('carrier-no-scan')).toContainText('Amazon has the package, the carrier does not.');
    await expect(page.getByTestId('reconciliation-required')).toContainText('A corrective second order is never placed.');
    const path = testInfo.outputPath('creators-samples-1440x1024.png');
    await page.screenshot({ path, animations: 'disabled', style: 'nextjs-portal { display: none; }' });
    await testInfo.attach('creators-samples', { path, contentType: 'image/png' });
  } finally {
    await db.close();
  }
});
