/**
 * WP-338g live: an admin seals a synthetic address on /creators/samples/[key]/preflight,
 * the browser posts only {binding, envelope}, a simulated MCF worker records a
 * preview through the service-role ledger functions, and "Send 1 unit via
 * Amazon" approves it. The route carries a nonce CSP; other routes do not.
 * WP-338i live: on a placed send, "Cancel in Amazon" queues one read, the
 * simulated worker records the cancel preview, "Cancel 1 order in Amazon"
 * approves it, and the worker's reservation, answer and a read showing
 * Cancelled settle the send and the lane.
 *
 * Synthetic rows only. Nothing calls Amazon: the "worker" here is two SQL calls.
 * The public key comes from global setup, which discarded its private half, so
 * nothing in this run can open what the browser sealed. Screenshots are taken
 * only after the form is cleared.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { expect, test, type Page, type Request, type TestInfo } from '@playwright/test';
import {
  CREATOR_MCF_ENVELOPE_SUITE, CREATOR_MCF_IRREVERSIBILITY, CreatorMcfCancelPreview, CreatorMcfPreview, CreatorPreflightCheck, creatorMcfBase64UrlEncode,
  creatorMcfCanonicalJson, creatorPreflightChecks,
} from '@wizard-ads/shared';
import { approveCreatorMcfSend, createDb, sealCreatorMcfRecipient, type DbHandle } from '@wizard-ads/db';
import { asServiceRole } from '@wizard-ads/db/testing';
import { signIn } from './support/auth';
import { BASE_URL, USERS, readState } from './support/fixture';

const COUNTS = '{"records":null,"action_log":null,"queue_items":null,"sweep_runs":null,"sample_shipments":null,"preflights":null}';
const DIGEST = '0'.repeat(64);
/** One canary per field. None may appear in the action body, the database or the page after sealing, in any encoding. */
const CANARY = {
  name: 'Qx Canaryperson Vz', addressLine1: '77 Canarylane Road', addressLine2: 'Canaryunit 9', city: 'Canaryville', stateOrRegion: 'CA',
  postalCode: '94999-0042',
} as const;
const encodings = (value: string) => [value, value.toLowerCase(), encodeURIComponent(value), Buffer.from(value).toString('base64'),
  Buffer.from(value).toString('base64url'), Buffer.from(value).toString('hex')];

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}-1440x1024.png`);
  await page.screenshot({ path, animations: 'disabled', style: 'nextjs-portal { display: none; }', fullPage: true });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

function publicKeyId(): string {
  const raw = process.env['OPENSPELL_MCF_RECIPIENT_PUBLIC_KEY'];
  if (raw === undefined) throw new Error('global setup did not set OPENSPELL_MCF_RECIPIENT_PUBLIC_KEY');
  return (JSON.parse(raw) as { keyId: string }).keyId;
}

/** A passing pre-flight's detail, as the runner records it (WP-334's shape), read one minute ago. */
function preflightDetail(sku: string, asin: string) {
  const readAt = new Date(Date.now() - 60_000).toISOString();
  return {
    computedScore: 10, checks: creatorPreflightChecks([], CreatorPreflightCheck.options.map((check) => ({ check, readAt, evidenceReference: `ev:e7-${check}` }))),
    sku, campaignId: 'campaign-e7', productTitle: 'Synthetic roller', trackerSourceRef: 'tracker row 301', quantity: 1, feeCents: 620, feeCapCents: 800,
    inventory: { asin, sku, fulfillmentChannel: 'AFN', mcfFulfillable: true, fulfillableQuantity: 37, checkedAt: readAt, evidenceReference: 'ev:e7-inventory' },
    preview: { operation: 'getFulfillmentPreview', readAt, validUntil: null, isFulfillable: true, feeCents: 620, currency: 'USD', constraints: [] },
  };
}

interface Scope { connection: string; marketplace: string; scope: string }
interface Restore { connections: { id: string; status: string; vault_secret_id: string | null }[]; bindings: { id: string; enabled: boolean }[] }

/** Makes the organisation's one SP-API binding usable, and returns what to restore afterwards. */
async function usableBinding(db: DbHandle, org: string): Promise<{ scope: Scope; restore: Restore }> {
  const connections = await db.sql<Restore['connections']>`select id, status, vault_secret_id from public.spapi_connections where org_id = ${org}`;
  const bindings = await db.sql<Restore['bindings']>`select id, enabled from public.spapi_profile_bindings where org_id = ${org}`;
  await asServiceRole(db, (sql) => sql`update public.spapi_connections set status = 'active', vault_secret_id = coalesce(vault_secret_id, gen_random_uuid())
    where org_id = ${org}`);
  await db.sql`update public.spapi_profile_bindings set enabled = true where org_id = ${org}`;
  const usable = await db.sql<{ connection_id: string; marketplace_id: string }[]>`select * from app.creator_mcf_usable_bindings(${org})`;
  expect(usable, 'exactly one usable SP-API binding for the e2e organisation').toHaveLength(1);
  const [one] = usable;
  return { scope: { connection: one!.connection_id, marketplace: one!.marketplace_id, scope: `${one!.connection_id}:${one!.marketplace_id}` },
    restore: { connections: [...connections], bindings: [...bindings] } };
}

async function heartbeat(db: DbHandle, scope: Scope, at = 'now()') {
  await asServiceRole(db, (sql) => sql`select app.record_creator_mcf_heartbeat('e2e-mcf-worker', ${[scope.scope]}::text[], true, true, 'e2e-rev', null)`);
  if (at !== 'now()') await db.sql`update app.creator_mcf_worker_heartbeats set beat_at = now() - interval '10 minutes' where worker_id = 'e2e-mcf-worker'`;
}

/** The fields of app.claim_creator_mcf_outbox's answer this simulated worker reads. */
interface Claim {
  sendId: string; leaseId: string; sku: string; spapiConnectionId: string; marketplaceId: string; envelopeSha256: string; keyId: string;
  binding: { derivedOrderKey: string; reservationId: string; asin: string };
  preflight: { runId: string; completedAt: string };
  caps: { laneFeeCapMinor: number | null; grantFeeCapMinor: number | null; grantCurrency: string | null };
}

/** The MCF worker's preview step, as the ledger's service-role functions see it: claim, then record an address-free preview. */
async function workerPreview(db: DbHandle, scope: Scope, sendId: string): Promise<CreatorMcfPreview> {
  const claim = await asServiceRole(db, async (sql) => {
    const [row] = await sql<{ result: Claim | null }[]>`select app.claim_creator_mcf_outbox('e2e-mcf-worker', ${[scope.scope]}::text[],
      '{preview}') as result`;
    return row?.result ?? null;
  });
  if (claim === null) throw new Error('no preview work was due for the send');
  expect(claim.sendId).toBe(sendId);
  const readAt = new Date();
  const preview = CreatorMcfPreview.parse({
    previewId: randomUUID(), sendId, derivedOrderKey: claim.binding.derivedOrderKey, reservationId: claim.binding.reservationId,
    spapiConnectionId: claim.spapiConnectionId, marketplaceId: claim.marketplaceId, readAt: readAt.toISOString(),
    validUntil: new Date(readAt.getTime() + 30 * 60_000).toISOString(), workerRevision: 'e2e-rev', kind: 'preview',
    preflightRunId: claim.preflight.runId, preflightCompletedAt: new Date(claim.preflight.completedAt).toISOString(), asin: claim.binding.asin,
    items: [{ sellerSku: claim.sku, sellerFulfillmentOrderItemId: `${claim.binding.derivedOrderKey}-1`, quantity: 1 }], totalUnits: 1,
    shippingSpeedCategory: 'Standard', fulfillmentAction: 'Ship', fulfillmentPolicy: 'FillOrKill', featureConstraints: [], existingOrder: 'none',
    isFulfillable: true, fees: { parts: [{ feeName: 'FBAPerUnitFulfillmentFee', amountMinor: 620 }], totalMinor: 620, currency: 'USD' },
    unfulfillableReasons: [], earliestArrivalDate: '2026-10-02', latestArrivalDate: '2026-10-05',
    laneFeeCapMinor: claim.caps.laneFeeCapMinor, grantFeeCapMinor: claim.caps.grantFeeCapMinor, grantCurrency: claim.caps.grantCurrency,
    envelopeSha256: claim.envelopeSha256, keyId: claim.keyId, irreversibility: CREATOR_MCF_IRREVERSIBILITY,
  });
  const decision = await asServiceRole(db, async (sql) => {
    const [row] = await sql<{ result: { decision: string } }[]>`select app.record_creator_mcf_preview(${sendId}::uuid, ${claim.leaseId}::uuid,
      ${creatorMcfCanonicalJson(preview)}) as result`;
    return row!.result.decision;
  });
  expect(decision).toBe('preview_ready');
  return preview;
}

test('sample send: seal in the browser, post only the envelope, preview, and "Send 1 unit via Amazon" under a nonce CSP on /creators/samples only', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 1024 });
  const state = await readState();
  const db = createDb({ connectionString: state.connectionString, max: 2 });
  const org = state.orgId;
  const { scope, restore } = await usableBinding(db, org);
  try {
    const keyId = publicKeyId();
    const record = 'CCR-E7-26-0301';
    const asin = 'B0E7K3M2QP';
    const sku = 'SW-E7-05-FBA';
    const reservation = `MCFR-${randomBytes(8).toString('hex').toUpperCase()}`;
    const key = `CCS-${createHash('sha256').update(`${org}|${record}|${asin}`).digest('hex').slice(0, 32)}`;
    await db.sql`update app.creator_mcf_grants set revoked_at = now() where org_id = ${org} and revoked_at is null`;
    await db.sql`insert into app.creator_mcf_grants(org_id, spapi_connection_id, marketplace_id, action_classes, recipient_key_ids, max_units_per_day,
        max_fee_minor, currency, enabled_by, enabled_at, expires_at)
      values (${org}, ${scope.connection}, ${scope.marketplace}, '{send}', ${[keyId]}::text[], 20, 1500, 'USD', 'synthetic e2e operator', now(),
        now() + interval '1 day')`;
    await heartbeat(db, scope);
    await db.sql`insert into public.creator_records(org_id, creator_record_id, brand, campaign_id, storefront_fp, record_state, lock_state, runner_version,
        created_on, source, source_digest)
      values (${org}, ${record}, 'Synthetic brand', 'campaign-e7', ${createHash('sha256').update(`synthetic:e7:${record}`).digest('hex')},
        'Active', 'Unlocked', 1, '2026-09-01', 'control-runner', ${DIGEST}) on conflict do nothing`;
    await db.sql`insert into public.creator_sample_shipments(org_id, creator_record_id, asin, sku, campaign_id, reservation_id, lane_state, fee_cents,
        fee_cap_cents, reserved_at, source, source_digest)
      values (${org}, ${record}, ${asin}, ${sku}, 'campaign-e7', ${reservation}, 'Reserved', 620, 800, now() - interval '5 minutes', 'control-runner',
        ${DIGEST})`;
    await db.sql`insert into public.creator_sample_preflights(org_id, run_id, command, creator_record_id, asin, result, errors, required_next_state, detail,
        started_at, completed_at, source, source_digest)
      values (${org}, ${`e7-pass-${randomBytes(3).toString('hex')}`}, 'preflight', ${record}, ${asin}, 'PASS', '{}', 'Locked for MCF',
        ${JSON.stringify(preflightDetail(sku, asin))}::jsonb, now() - interval '65 seconds', now() - interval '60 seconds',
        'control-runner', ${DIGEST})`;
    await db.sql`insert into public.creator_import_runs(org_id, started_at, finished_at, status, files, counts, source)
      values (${org}, clock_timestamp(), clock_timestamp(), 'succeeded', '{registry,preflight_results}', ${COUNTS}::jsonb, 'control-runner')`;

    const offOrigin: string[] = [];
    const cspErrors: string[] = [];
    page.on('request', (request) => { if (!/^(data|blob):/.test(request.url()) && new URL(request.url()).origin !== BASE_URL) offOrigin.push(request.url()); });
    page.on('console', (message) => { if (/Content Security Policy|Refused to (execute|load|apply)/i.test(message.text())) cspErrors.push(message.text()); });
    const actionBodies: string[] = [];
    page.on('request', (request: Request) => { if (request.method() === 'POST' && request.headers()['next-action'] !== undefined) actionBodies.push(request.postData() ?? ''); });

    await signIn(page, 'admin');
    const response = await page.goto(`/creators/samples/${key}/preflight`);
    const csp = response!.headers()['content-security-policy'] ?? '';
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce, 'a nonce in the CSP').toBeTruthy();
    expect(csp).toContain(`script-src 'self' 'nonce-${nonce}'`);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/https?:\/\/|\*/);

    // Hydration: the address form renders only in the browser, after React takes over.
    const section = page.getByTestId('mcf-send');
    await expect(section.getByTestId('sending-status')).toHaveAttribute('data-sending', 'on');
    await expect(page.getByTestId('address-form')).toBeVisible();
    const fields = page.locator('[data-testid="address-form"] [data-recipient-field]');
    await expect(fields).toHaveCount(9);
    expect(await fields.evaluateAll((items) => items.filter((item) => item.hasAttribute('name') || item.getAttribute('autocomplete') !== 'off').length)).toBe(0);
    const scripts = await page.evaluate(() => [...document.scripts].map((script) => script.src).filter(Boolean));
    expect(scripts.length).toBeGreaterThan(0);
    for (const src of scripts) expect(new URL(src).origin).toBe(BASE_URL);

    for (const [field, value] of Object.entries(CANARY)) await page.locator(`[data-recipient-field="${field}"]`).fill(value);
    await page.getByTestId('review-address').click();
    await expect(page.getByTestId('review-record')).toHaveText(record);
    await expect(page.getByTestId('review-block')).toContainText(CANARY.addressLine1);
    const posted = page.waitForRequest((request) => request.method() === 'POST' && request.headers()['next-action'] !== undefined);
    await page.getByTestId('seal-address').click();
    await posted;
    await expect(page.locator('[data-testid="send-card"][data-send-state="sealed"]')).toBeVisible();
    await expect(page.getByTestId('sealed-mask')).toContainText('Address sealed · US · 94••• · 2 lines · expires');
    await expect(page.getByTestId('sealed-memory')).toHaveText('In this tab only: Q. C. V. · 94999-0042. Never stored or sent.');
    await expect(page.locator('[data-recipient-field]')).toHaveCount(0);
    expect(new URL(page.url()).search).toBe('');

    // Every server action body is free of the canaries; the seal's is one argument, exactly {binding, envelope}.
    // (The root layout posts its own action with a null argument on load.)
    for (const posted of actionBodies) {
      for (const value of Object.values(CANARY).filter((text) => text.length > 3)) {
        for (const form of encodings(value)) expect(posted).not.toContain(form);
      }
    }
    const sealBodies = actionBodies.filter((posted) => posted.includes('"envelope"'));
    expect(sealBodies).toHaveLength(1);
    expect(actionBodies.filter((posted) => !posted.includes('"envelope"')).every((posted) => posted === '[null]')).toBe(true);
    const args = JSON.parse(sealBodies[0]!) as unknown[];
    expect(args).toHaveLength(1);
    const body = args[0] as { binding: Record<string, unknown>; envelope: Record<string, unknown> };
    expect(Object.keys(body).sort()).toEqual(['binding', 'envelope']);
    expect(Object.keys(body.envelope).sort()).toEqual(['ciphertext', 'enc', 'envelopeId', 'keyId', 'mask', 'suite', 'v']);
    expect(body.binding).toEqual({ orgId: org, creatorRecordId: record, asin, derivedOrderKey: key, reservationId: reservation });
    expect(body.envelope['keyId']).toBe(keyId);

    // The ledger holds ciphertext and the mask; no canary in the send, its events or the page.
    const [send] = await db.sql<{ id: string; state: string; mask: unknown; row: string }[]>`select id, state, mask, row_to_json(s)::text as row
      from public.creator_mcf_sends s where org_id = ${org} and derived_order_key = ${key}`;
    expect(send?.state).toBe('sealed');
    expect(send?.mask).toEqual({ countryCode: 'US', postalPrefix: '94', lines: 2 });
    const events = await db.sql<{ row: string }[]>`select row_to_json(e)::text as row from public.creator_mcf_send_events e where send_id = ${send!.id}`;
    const html = await page.content();
    for (const value of Object.values(CANARY).filter((text) => text.length > 3)) {
      for (const text of [send!.row, ...events.map((event) => event.row)]) expect(text).not.toContain(value);
      // The sealed card shows the full postal code from this tab's memory, by design; nothing else typed stays on the page.
      if (value !== CANARY.postalCode) expect(html).not.toContain(value);
    }
    await capture(page, testInfo, 'creators-send-sealed');

    // The worker previews; the page refreshes itself and this tab still remembers the initials.
    const preview = await workerPreview(db, scope, send!.id);
    await expect(page.locator('[data-testid="send-card"][data-send-state="preview_ready"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('sealed-memory')).toBeVisible();
    await expect(page.getByTestId('mcf-preview').locator('[data-fact="order-id"]')).toHaveText(key);
    await expect(page.getByTestId('irreversibility')).toHaveText(CREATOR_MCF_IRREVERSIBILITY);
    await expect(page.getByTestId('sku-line')).toHaveText(`1 × ${sku} (${asin})`);
    await expect(page.getByTestId('send-button')).toHaveText('Send 1 unit via Amazon');
    await capture(page, testInfo, 'creators-send-preview-ready');

    // A heartbeat older than 5 minutes turns sending off: no Send button, and the screen says why.
    await heartbeat(db, scope, 'stale');
    await page.reload();
    await expect(page.locator('[data-testid="sending-off"] [data-missing="heartbeat"]')).toBeVisible();
    await expect(page.getByTestId('send-button')).toHaveCount(0);
    await heartbeat(db, scope);
    await page.reload();
    await expect(page.getByTestId('sealed-memory')).toHaveCount(0);

    await page.getByTestId('send-button').click();
    await expect(page.locator('[data-testid="send-card"][data-send-state="approved"]')).toBeVisible();
    await expect(page.getByTestId('approved-note')).toContainText('the approval expires and nothing is sent');
    const [approved] = await db.sql<{ state: string; confirmation_text: string; approved_units: number; approved_preview_id: string }[]>`
      select state, confirmation_text, approved_units, approved_preview_id from public.creator_mcf_sends where id = ${send!.id}`;
    expect(approved).toEqual({ state: 'approved', confirmation_text: 'Send 1 unit via Amazon', approved_units: 1, approved_preview_id: preview.previewId });
    await capture(page, testInfo, 'creators-send-approved');

    // The list: units today against the cap, sending on, and the lane's send state, under its own fresh nonce.
    const list = await page.goto('/creators/samples');
    const listNonce = /'nonce-([^']+)'/.exec(list!.headers()['content-security-policy'] ?? '')?.[1];
    expect(listNonce, 'a nonce on /creators/samples').toBeTruthy();
    expect(listNonce).not.toBe(nonce);
    await expect(page.getByTestId('sending-header')).toHaveAttribute('data-sending', 'on');
    await expect(page.getByTestId('sending-header').getByTestId('units-today')).toContainText(/Units approved today \(UTC\): \d+ of 20/);
    await expect(page.getByTestId('sample-lane').filter({ hasText: record }).getByTestId('send-state')).toHaveAttribute('data-send-state', 'approved');

    // Withdraw before the worker claims it: custody is destroyed and nothing is left behind.
    const again = await page.goto(`/creators/samples/${key}/preflight`);
    const againNonce = /'nonce-([^']+)'/.exec(again!.headers()['content-security-policy'] ?? '')?.[1];
    expect(new Set([nonce, listNonce, againNonce]).size).toBe(3);
    await page.getByTestId('withdraw').click();
    await expect(page.locator('[data-testid="send-card"][data-send-state="withdrawn"]')).toBeVisible();
    const [residue] = await db.sql<{ expired_live: number; custody_free_live: number }[]>`select * from app.creator_mcf_custody_residue()`;
    expect(residue).toEqual({ expired_live: 0, custody_free_live: 0 });
    const [custody] = await db.sql<{ n: number }[]>`select count(*)::int as n from app.creator_mcf_recipient_custody where send_id = ${send!.id}`;
    expect(custody?.n).toBe(0);
    expect(offOrigin).toEqual([]);
    expect(cspErrors).toEqual([]);

    // Outside /creators/samples there is no CSP. /creators is a route another spec in this suite already compiles: the suite runs every
    // route-acceptance spec in one dev process, and each extra route or page load adds to that process's heap (a new route here pushed it
    // past its 8 GB limit in CI).
    const outside = await page.request.get('/creators');
    expect(outside.status()).toBe(200);
    expect(outside.headers()['content-security-policy'], 'no CSP on /creators').toBeUndefined();
  } finally {
    await db.sql`update app.creator_mcf_grants set revoked_at = now() where org_id = ${org} and revoked_at is null`;
    await db.sql`delete from app.creator_mcf_worker_heartbeats where worker_id = 'e2e-mcf-worker'`;
    for (const binding of restore.bindings) await db.sql`update public.spapi_profile_bindings set enabled = ${binding.enabled} where id = ${binding.id}`;
    for (const connection of restore.connections) {
      await asServiceRole(db, (sql) => sql`update public.spapi_connections set status = ${connection.status}, vault_secret_id = ${connection.vault_secret_id}
        where id = ${connection.id}`);
    }
    await db.close();
  }
});

/** A found getFulfillmentOrder read of this lane's order: one unit of the SKU, in `status`, read now. */
function orderRead(key: string, sku: string, status: string, readAt = new Date()) {
  return { outcome: 'found', operation: 'getFulfillmentOrder', status, readAt: readAt.toISOString(), sellerFulfillmentOrderId: key,
    items: [{ sellerSku: sku, quantity: 1, cancelledQuantity: 0, unfulfillableQuantity: 0 }], shipments: [], packages: [] };
}

/** One service-role ledger call that answers jsonb. */
async function worker<T = Record<string, unknown>>(db: DbHandle, call: (sql: Parameters<Parameters<typeof asServiceRole>[1]>[0]) => Promise<{ result: T }[]>): Promise<T> {
  return asServiceRole(db, async (sql) => (await call(sql))[0]!.result);
}

interface CancelClaim extends Claim {
  cancel: { mode: 'preview' | 'execute'; originState: string; cancelId?: string; previewId?: string } | null;
}

async function claimCancel(db: DbHandle, scope: Scope, sendId: string): Promise<CancelClaim> {
  const claim = await worker<CancelClaim | null>(db, (sql) => sql`select app.claim_creator_mcf_outbox('e2e-mcf-worker', ${[scope.scope]}::text[],
    '{cancel}') as result`);
  if (claim === null) throw new Error('no cancel work was due for the send');
  expect(claim.sendId).toBe(sendId);
  return claim;
}

test('sample cancel: "Cancel in Amazon" reads the order, "Cancel 1 order in Amazon" approves it, and a read showing Cancelled settles it', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 1024 });
  const state = await readState();
  const db = createDb({ connectionString: state.connectionString, max: 2 });
  const org = state.orgId;
  const { scope, restore } = await usableBinding(db, org);
  try {
    const keyId = publicKeyId();
    const record = 'CCR-E7-26-0302';
    const asin = 'B0E7K3M2QR';
    const sku = 'SW-E7-06-FBA';
    const reservation = `MCFR-${randomBytes(8).toString('hex').toUpperCase()}`;
    const key = `CCS-${createHash('sha256').update(`${org}|${record}|${asin}`).digest('hex').slice(0, 32)}`;
    const admin = { orgId: org, userId: USERS.admin };
    await db.sql`update app.creator_mcf_grants set revoked_at = now() where org_id = ${org} and revoked_at is null`;
    await db.sql`insert into app.creator_mcf_grants(org_id, spapi_connection_id, marketplace_id, action_classes, recipient_key_ids, max_units_per_day,
        max_fee_minor, currency, enabled_by, enabled_at, expires_at)
      values (${org}, ${scope.connection}, ${scope.marketplace}, '{send,cancel}', ${[keyId]}::text[], 20, 1500, 'USD', 'synthetic e2e operator', now(),
        now() + interval '1 day')`;
    await heartbeat(db, scope);
    await db.sql`insert into public.creator_records(org_id, creator_record_id, brand, campaign_id, storefront_fp, record_state, lock_state, runner_version,
        created_on, source, source_digest)
      values (${org}, ${record}, 'Synthetic brand', 'campaign-e7', ${createHash('sha256').update(`synthetic:e7:${record}`).digest('hex')},
        'Active', 'Unlocked', 1, '2026-09-01', 'control-runner', ${DIGEST}) on conflict do nothing`;
    await db.sql`insert into public.creator_sample_shipments(org_id, creator_record_id, asin, sku, campaign_id, reservation_id, lane_state, fee_cents,
        fee_cap_cents, reserved_at, source, source_digest)
      values (${org}, ${record}, ${asin}, ${sku}, 'campaign-e7', ${reservation}, 'Reserved', 620, 800, now() - interval '5 minutes', 'control-runner',
        ${DIGEST})`;
    await db.sql`insert into public.creator_sample_preflights(org_id, run_id, command, creator_record_id, asin, result, errors, required_next_state, detail,
        started_at, completed_at, source, source_digest)
      values (${org}, ${`e7-cancel-${randomBytes(3).toString('hex')}`}, 'preflight', ${record}, ${asin}, 'PASS', '{}', 'Locked for MCF',
        ${JSON.stringify(preflightDetail(sku, asin))}::jsonb, now() - interval '65 seconds', now() - interval '60 seconds',
        'control-runner', ${DIGEST})`;
    await db.sql`insert into public.creator_import_runs(org_id, started_at, finished_at, status, files, counts, source)
      values (${org}, clock_timestamp(), clock_timestamp(), 'succeeded', '{registry,preflight_results}', ${COUNTS}::jsonb, 'control-runner')`;

    // To placed, through the ledger alone: a synthetic random-bytes envelope nobody can open, the worker's preview, the admin's
    // "Send 1 unit via Amazon", the dispatch re-read, the one POST reserved and accepted, and a read that finds the order Received.
    const envelope = { v: 1, suite: CREATOR_MCF_ENVELOPE_SUITE, envelopeId: randomUUID(), keyId,
      enc: creatorMcfBase64UrlEncode(Uint8Array.of(4, ...randomBytes(64))), ciphertext: creatorMcfBase64UrlEncode(randomBytes(48)),
      mask: { countryCode: 'US', postalPrefix: '94', lines: 2 } };
    const sealed = await sealCreatorMcfRecipient(db, admin, { creatorRecordId: record, asin,
      request: { binding: { orgId: org, creatorRecordId: record, asin, derivedOrderKey: key, reservationId: reservation }, envelope } });
    if (sealed.outcome !== 'sealed') throw new Error(`seal refused: ${sealed.reason}`);
    const sendId = sealed.sendId;
    const preview = await workerPreview(db, scope, sendId);
    const [latest] = await db.sql<{ fingerprint: string }[]>`select fingerprint from public.creator_mcf_send_previews where id = ${preview.previewId}`;
    const approved = await approveCreatorMcfSend(db, admin, { sendId, previewId: preview.previewId, previewFingerprint: latest!.fingerprint, totalUnits: 1,
      confirmation: 'Send 1 unit via Amazon', requestId: randomUUID() });
    expect(approved.outcome).toBe('approved');
    const dispatch = await worker<Claim | null>(db, (sql) => sql`select app.claim_creator_mcf_outbox('e2e-mcf-worker', ${[scope.scope]}::text[],
      '{dispatch}') as result`);
    expect(dispatch?.sendId).toBe(sendId);
    const rereadAt = new Date();
    const reread = CreatorMcfPreview.parse({ ...preview, previewId: randomUUID(), kind: 'dispatch_reread', readAt: rereadAt.toISOString(),
      validUntil: new Date(rereadAt.getTime() + 30 * 60_000).toISOString() });
    expect((await worker<{ decision: string }>(db, (sql) => sql`select app.record_creator_mcf_preview(${sendId}::uuid, ${dispatch!.leaseId}::uuid,
      ${creatorMcfCanonicalJson(reread)}) as result`)).decision).toBe('same');
    expect((await worker<{ decision: string }>(db, (sql) => sql`select app.reserve_creator_mcf_dispatch(${sendId}::uuid, ${dispatch!.leaseId}::uuid,
      ${'d1'.repeat(32)}) as result`)).decision).toBe('dispatch_once');
    expect(await worker(db, (sql) => sql`select app.record_creator_mcf_outcome(${sendId}::uuid, ${dispatch!.leaseId}::uuid,
      '{"outcome":"accepted","status":200}'::jsonb, null) as result`)).toMatchObject({ state: 'accepted' });
    expect(await worker(db, (sql) => sql`select app.record_creator_mcf_settlement(${sendId}::uuid,
      ${JSON.stringify(orderRead(key, sku, 'Received'))}::text::jsonb, null) as result`)).toMatchObject({ state: 'placed' });

    const offOrigin: string[] = [];
    const cspErrors: string[] = [];
    page.on('request', (request) => { if (!/^(data|blob):/.test(request.url()) && new URL(request.url()).origin !== BASE_URL) offOrigin.push(request.url()); });
    page.on('console', (message) => { if (/Content Security Policy|Refused to (execute|load|apply)/i.test(message.text())) cspErrors.push(message.text()); });

    await signIn(page, 'admin');
    await page.goto(`/creators/samples/${key}/preflight`);
    await expect(page.locator('[data-testid="send-card"][data-send-state="placed"]')).toBeVisible();
    const offer = page.getByTestId('cancel-in-amazon');
    await expect(offer).toHaveText('Cancel in Amazon');
    await expect(offer).toBeEnabled();
    await offer.click();
    await expect(page.getByTestId('cancel-reading')).toBeVisible();
    const [queued] = await db.sql<{ n: number }[]>`select count(*)::int as n from public.creator_mcf_outbox
      where send_id = ${sendId} and action = 'cancel' and completed_at is null`;
    expect(queued?.n).toBe(1);

    // The worker's cancel preview: one getOrder read showing Received, valid for 5 minutes.
    const readClaim = await claimCancel(db, scope, sendId);
    expect(readClaim.cancel).toMatchObject({ mode: 'preview', originState: 'placed' });
    const readAt = new Date();
    const cancelPreview = CreatorMcfCancelPreview.parse({
      previewId: randomUUID(), sendId, derivedOrderKey: key, reservationId: reservation, spapiConnectionId: readClaim.spapiConnectionId,
      marketplaceId: readClaim.marketplaceId, readAt: readAt.toISOString(), validUntil: new Date(readAt.getTime() + 5 * 60_000).toISOString(),
      workerRevision: 'e2e-rev', kind: 'cancel_preview', existingOrder: { status: 'Received' },
      items: [{ sellerSku: sku, sellerFulfillmentOrderItemId: `${key}-1`, quantity: 1 }], totalUnits: 1,
    });
    const ready = await worker<{ decision: string; previewId: string; fingerprint: string }>(db, (sql) => sql`select app.record_creator_mcf_cancel_preview(
      ${sendId}::uuid, ${readClaim.leaseId}::uuid, ${JSON.stringify(orderRead(key, sku, 'Received', readAt))}::text::jsonb,
      ${creatorMcfCanonicalJson(cancelPreview)}) as result`);
    expect(ready.decision).toBe('cancel_preview_ready');

    const card = page.getByTestId('cancel-preview');
    await expect(card).toHaveAttribute('data-current', 'true', { timeout: 30_000 });
    await expect(card.locator('[data-fact="order-id"]')).toHaveText(key);
    await expect(card.locator('[data-fact="status"]')).toHaveText('Received');
    await expect(card.locator('[data-fact="items"]')).toHaveText(`1 × ${sku}`);
    await expect(card.locator('[data-fact="total"]')).toHaveText('1 unit');
    const button = page.getByTestId('cancel-button');
    await expect(button).toHaveText('Cancel 1 order in Amazon');
    expect(await button.textContent()).toBe('Cancel 1 order in Amazon');
    await capture(page, testInfo, 'creators-cancel-preview');

    await button.click();
    await expect(page.getByTestId('cancel-approved')).toBeVisible();
    await expect(page.getByTestId('cancel-approved')).toContainText('the cancel expires and nothing is sent to Amazon');
    const cancels = await db.sql<{ id: string; confirmation_text: string; origin_state: string; reserved_at: Date | null; preview_id: string }[]>`
      select id, confirmation_text, origin_state, reserved_at, preview_id from app.creator_mcf_cancels where send_id = ${sendId}`;
    expect(cancels).toHaveLength(1);
    expect(cancels[0]).toMatchObject({ confirmation_text: 'Cancel 1 order in Amazon', origin_state: 'placed', reserved_at: null, preview_id: ready.previewId });
    const [still] = await db.sql<{ state: string }[]>`select state from public.creator_mcf_sends where id = ${sendId}`;
    expect(still?.state).toBe('placed');
    await capture(page, testInfo, 'creators-cancel-approved');

    // The worker takes the approved cancel, re-reads the order after the approval, sends the one request, and Amazon answers 200.
    const execute = await claimCancel(db, scope, sendId);
    expect(execute.cancel).toMatchObject({ mode: 'execute', originState: 'placed', cancelId: cancels[0]!.id, previewId: ready.previewId });
    const reserved = await worker<{ decision: string; cancelId: string }>(db, (sql) => sql`select app.reserve_creator_mcf_cancel(${sendId}::uuid,
      ${execute.leaseId}::uuid, ${JSON.stringify(orderRead(key, sku, 'Received'))}::text::jsonb, ${'ca'.repeat(32)}) as result`);
    expect(reserved).toMatchObject({ decision: 'cancel_once', cancelId: cancels[0]!.id });
    await worker(db, (sql) => sql`select app.record_creator_mcf_cancel_outcome(${sendId}::uuid, ${execute.leaseId}::uuid,
      '{"outcome":"accepted","status":200}'::jsonb, null) as result`);
    await expect(page.locator('[data-testid="send-card"][data-send-state="cancel_dispatching"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('cancel-dispatching').locator('[data-fact="answer"]')).toContainText('That is not proof');

    // A read after the reservation shows Cancelled: the send and the lane settle.
    expect(await worker(db, (sql) => sql`select app.record_creator_mcf_settlement(${sendId}::uuid,
      ${JSON.stringify(orderRead(key, sku, 'Cancelled'))}::text::jsonb, null) as result`)).toMatchObject({ state: 'cancelled' });
    await expect(page.locator('[data-testid="send-card"][data-send-state="cancelled"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('cancel-note')).toContainText('Cancelled in Amazon at Arcana\'s request');
    await expect(page.getByTestId('cancel-note')).toContainText('The lane is Cancelled with the reason operator_cancelled_in_amazon.');
    expect(await page.locator('[data-testid="mcf-send"] button').count()).toBe(0);
    await capture(page, testInfo, 'creators-cancel-cancelled');

    const [lane] = await db.sql<{ lane_state: string; cancellation_reason: string | null }[]>`select lane_state, cancellation_reason
      from public.creator_sample_shipments where org_id = ${org} and creator_record_id = ${record} and asin = ${asin}`;
    expect(lane).toEqual({ lane_state: 'Cancelled', cancellation_reason: 'operator_cancelled_in_amazon' });
    const [ended] = await db.sql<{ ending: string | null; puts: number }[]>`select ending, puts from app.creator_mcf_cancels where send_id = ${sendId}`;
    expect(ended).toEqual({ ending: 'cancelled', puts: 1 });
    const [custody] = await db.sql<{ n: number }[]>`select count(*)::int as n from app.creator_mcf_recipient_custody where send_id = ${sendId}`;
    expect(custody?.n).toBe(0);
    const [residue] = await db.sql<{ expired_live: number; custody_free_live: number }[]>`select * from app.creator_mcf_custody_residue()`;
    expect(residue).toEqual({ expired_live: 0, custody_free_live: 0 });
    expect(offOrigin).toEqual([]);
    expect(cspErrors).toEqual([]);
  } finally {
    await db.sql`update app.creator_mcf_grants set revoked_at = now() where org_id = ${org} and revoked_at is null`;
    await db.sql`delete from app.creator_mcf_worker_heartbeats where worker_id = 'e2e-mcf-worker'`;
    for (const binding of restore.bindings) await db.sql`update public.spapi_profile_bindings set enabled = ${binding.enabled} where id = ${binding.id}`;
    for (const connection of restore.connections) {
      await asServiceRole(db, (sql) => sql`update public.spapi_connections set status = ${connection.status}, vault_secret_id = ${connection.vault_secret_id}
        where id = ${connection.id}`);
    }
    await db.close();
  }
});
