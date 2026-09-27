/**
 * `/creators/samples/fulfillment/[id]` live: an ambiguous submit that Amazon
 * answered "no such order" twice, and a found order whose package has a
 * tracking number and no carrier status. The observation rows are inserted
 * directly; their trigger moves each lane's settlement, and nothing changes the
 * lane state or the lock. Synthetic rows only; no Amazon call is made.
 */
import { createHash } from 'node:crypto';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createDb } from '@wizard-ads/db';
import { signIn } from './support/auth';
import { readState } from './support/fixture';

const COUNTS = '{"records":null,"action_log":null,"queue_items":null,"sweep_runs":null,"sample_shipments":null,"preflights":null}';
const DIGEST = '0'.repeat(64);
const ASIN = 'B0D9K3M2QP';

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}-1440x1024.png`);
  await page.screenshot({ path, animations: 'disabled', style: 'nextjs-portal { display: none; }', fullPage: true });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

test('sample order: an ambiguous submit read as not found twice, and a found order the carrier has not scanned', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 1024 });
  const state = await readState();
  const db = createDb({ connectionString: state.connectionString, max: 1 });
  try {
    const org = state.orgId;
    const key = (record: string) => `CCS-${createHash('sha256').update(`${org}|${record}|${ASIN}`).digest('hex').slice(0, 32)}`;
    const ambiguousKey = key('CCR-E6-26-0072');
    const foundKey = key('CCR-E6-26-0088');

    await db.sql`insert into public.creator_records(org_id, creator_record_id, brand, campaign_id, record_state, lock_state, runner_version, created_on,
        source, source_digest)
      values (${org}, 'CCR-E6-26-0072', 'Synthetic brand', 'campaign-e6', 'Active', 'Locked for MCF', 2, '2026-09-01', 'control-runner', ${DIGEST}),
        (${org}, 'CCR-E6-26-0088', 'Synthetic brand', 'campaign-e6', 'Active', 'Locked for MCF', 2, '2026-09-01', 'control-runner', ${DIGEST})
      on conflict do nothing`;
    await db.sql`insert into public.creator_sample_shipments(org_id, creator_record_id, asin, sku, reservation_id, lane_state, fee_cents, fee_cap_cents,
        verified_at, reconciliation_reason, source, source_digest)
      values (${org}, 'CCR-E6-26-0072', ${ASIN}, 'SW-DERMA-05-FBA', 'MCFR-9f2c41ab77e0d3e6', 'Reconciliation Required', 620, 800,
        '2026-09-08T06:44:12Z', 'outcome_unknown', 'control-runner', ${DIGEST}) on conflict do nothing`;
    await db.sql`insert into public.creator_sample_shipments(org_id, creator_record_id, asin, sku, reservation_id, lane_state, runner_order_id, fee_cents,
        fee_cap_cents, reserved_at, verified_at, confirmed_at, source, source_digest)
      values (${org}, 'CCR-E6-26-0088', ${ASIN}, 'SW-DERMA-05-FBA', 'MCFR-00000000000000E6', 'Confirmed', ${foundKey}, 620, 800,
        '2026-09-09T06:33:19Z', '2026-09-09T06:34:41Z', '2026-09-09T06:40:00Z', 'control-runner', ${DIGEST}) on conflict do nothing`;

    // Two not-found reads on the ambiguous lane, older first, so the trigger counts them in order.
    for (const [observationKey, readAt] of [['e6:observe:0072:1', '2026-09-08T07:14:05Z'], ['e6:observe:0072:2', '2026-09-08T08:44:31Z']] as const) {
      await db.sql`insert into public.creator_mcf_observations(org_id, observation_key, creator_record_id, asin, queried_order_id, operation, outcome,
          read_at)
        values (${org}, ${observationKey}, 'CCR-E6-26-0072', ${ASIN}, ${ambiguousKey}, 'getFulfillmentOrder', 'not_found', ${readAt})
        on conflict do nothing`;
    }
    const shipments = JSON.stringify([{ amazonShipmentId: 'SYNTHETIC-SHIP-E6-A', status: 'PENDING', shippedAt: null, estimatedArrivalAt: '2026-09-12T18:00:00Z',
      packages: [{ packageNumber: 1, carrierCode: 'Synthetic carrier', trackingNumber: 'SYNTHETIC-TRACK-E6', estimatedArrivalAt: '2026-09-12T18:00:00Z' }] }]);
    const packages = JSON.stringify([{ packageNumber: 1, carrierCode: 'Synthetic carrier', trackingNumber: 'SYNTHETIC-TRACK-E6',
      estimatedArrivalAt: '2026-09-12T18:00:00Z', carrierStatus: null, carrierStatusReadAt: null }]);
    await db.sql`insert into public.creator_mcf_observations(org_id, observation_key, creator_record_id, asin, queried_order_id, operation, outcome,
        mcf_status, shipments, packages, read_at)
      values (${org}, 'e6:observe:0088:1', 'CCR-E6-26-0088', ${ASIN}, ${foundKey}, 'getFulfillmentOrder', 'found', 'Processing', ${shipments}::jsonb,
        ${packages}::jsonb, '2026-09-09T07:02:18Z') on conflict do nothing`;
    await db.sql`insert into public.creator_import_runs(org_id, started_at, finished_at, status, files, counts, source)
      values (${org}, clock_timestamp(), clock_timestamp(), 'succeeded', '{registry,mcf_reservations}', ${COUNTS}::jsonb, 'control-runner')`;

    await signIn(page, 'admin');

    await page.goto(`/creators/samples/fulfillment/${ambiguousKey}`);
    const ambiguous = page.getByTestId('creator-fulfillment');
    await expect(ambiguous.getByRole('heading', { level: 1 })).toContainText('Sample order');
    await expect(ambiguous.locator('[data-status="run-by-hand"]')).toHaveText('Run by hand');
    await expect(ambiguous).toHaveAttribute('data-lane', 'Reconciliation Required');
    await expect(ambiguous.getByTestId('order-key')).toHaveText(ambiguousKey);
    await expect(ambiguous.locator('[data-lock="Locked for MCF"]')).toHaveText('Locked for MCF');
    await expect(ambiguous.getByTestId('question')).toHaveCount(3);
    await expect(ambiguous.locator('[data-question="submitted"]')).toContainText('yes, verified for submit at 06:44:12');
    await expect(ambiguous.locator('[data-question="exists"]')).toHaveAttribute('data-answer', 'not-found');
    await expect(ambiguous.getByTestId('not-found-probes')).toHaveText('2 of 3');
    await expect(ambiguous.getByTestId('observation')).toHaveCount(2);
    await expect(ambiguous.getByTestId('observation-count')).toHaveText('2 of 2');
    await expect(ambiguous.getByTestId('settlement-line')).toHaveAttribute('data-settlement', 'not_found');
    await expect(ambiguous.getByTestId('no-new-order-id')).toContainText('A corrective second order is never placed');
    await expect(ambiguous.locator('button')).toHaveCount(0);
    await capture(page, testInfo, 'creators-fulfillment-ambiguous');

    await page.goto(`/creators/samples/fulfillment/${foundKey}`);
    const found = page.getByTestId('creator-fulfillment');
    await expect(found).toHaveAttribute('data-lane', 'Confirmed');
    await expect(found.getByTestId('not-safe-to-send')).toContainText('There is a tracking number, and it is not safe to send yet.');
    await expect(found.getByTestId('stage')).toHaveCount(4);
    expect(await found.getByTestId('stage').evaluateAll((stages) => stages.map((stage) => stage.getAttribute('data-answer'))))
      .toEqual(['done', 'now', 'not_yet', 'not_yet']);
    await expect(found.locator('[data-fact="order-status"]')).toContainText('Processing');
    await expect(found.locator('[data-fact="order-status"]')).toContainText('Amazon · getFulfillmentOrder · 07:02:18');
    await expect(found.getByTestId('amazon-shipment')).toHaveCount(1);
    await expect(found.getByTestId('amazon-package')).toHaveCount(1);
    await expect(found.getByTestId('amazon-package')).toContainText('SYNTHETIC-TRACK-E6');
    await expect(found.getByTestId('amazon-package')).toContainText('no carrier status yet');
    await expect(found.getByTestId('settlement-line')).toHaveAttribute('data-settlement', 'found');
    await expect(found.getByTestId('observation')).toHaveCount(1);
    await expect(found.getByTestId('observation')).toContainText('found · Processing');
    await expect(found.locator('button')).toHaveCount(0);
    await capture(page, testInfo, 'creators-fulfillment-found');

    await page.goto('/creators/samples/fulfillment/not-a-sample-key');
    await expect(page.getByTestId('creator-fulfillment')).toContainText('This address does not name a sample order key.');
  } finally {
    await db.close();
  }
});
