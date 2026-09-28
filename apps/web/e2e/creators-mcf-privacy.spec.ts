/**
 * WP-338j: the browser half of the MCF canary privacy suite.
 *
 * An admin types a synthetic recipient whose every field holds a unique token
 * on /creators/samples/[key]/preflight and seals it. A simulated MCF worker
 * (the ledger's service-role functions, as in creators-sample-send.spec.ts)
 * then takes one lane through preview, "Send 1 unit via Amazon", 200, placed
 * and the guarded cancel to Cancelled, and a second lane through preview,
 * approval and a 400 that the read confirms, to rejected. After every state
 * the preflight page, the fulfillment detail, the samples list and sync status
 * are loaded, and every token is searched for in plain, case-folded, base64,
 * base64url, hex and URL-encoded form in:
 *
 *  - every server-action request body and response;
 *  - every HTML document and every RSC payload the server sent;
 *  - the DOM after sealing (the sealed card keeps the typed postal code in this
 *    tab's memory by design, so the postal tokens alone are excepted until a
 *    reload) and the DOM after a reload (no exception);
 *  - the browser console;
 *  - the web server's log (global setup's copy of its stdout and stderr);
 *  - a data-only export of every table in every non-system schema.
 *
 * Positive controls: the review panel shows every token (the DOM scan finds
 * them there before sealing), and the scan finds a token spliced into a real
 * captured action body in each encoding.
 *
 * Synthetic data only; nothing calls Amazon. The public key comes from global
 * setup, which discarded its private half: nothing in this run can open what
 * the browser sealed. No screenshot is taken while a token is on screen.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  CREATOR_MCF_IRREVERSIBILITY, CreatorMcfCancelPreview, CreatorMcfPreview, CreatorPreflightCheck, creatorMcfCanonicalJson, creatorPreflightChecks,
} from '@wizard-ads/shared';
import { approveCreatorMcfSend, createDb, type DbHandle } from '@wizard-ads/db';
import { asServiceRole } from '@wizard-ads/db/testing';
import { signIn } from './support/auth';
import { APP_PORT, BASE_URL, USERS, readState } from './support/fixture';

const COUNTS = '{"records":null,"action_log":null,"queue_items":null,"sweep_runs":null,"sample_shipments":null,"preflights":null}';
const DIGEST = '0'.repeat(64);
const hex = (bytes: number) => randomBytes(bytes).toString('hex');

// ---------------------------------------------------------------------------
// The canary and the scan (the same six encodings as apps/worker/src/testing/canary-scan.ts; a workspace cannot import another's files).
// ---------------------------------------------------------------------------

const ENCODINGS = ['plain', 'casefold', 'base64', 'base64url', 'hex', 'url'] as const;
type Encoding = (typeof ENCODINGS)[number];

interface Canary { fields: Record<string, string>; tokens: string[]; postalTokens: string[] }

/** Every text field holds a label and 16 random hex characters, with a space so URL encoding differs from plain. */
function canary(): Canary {
  const field = (label: string) => `Qz${label} ${hex(8)}`;
  const postalCore = `Q${hex(5).toUpperCase()}`;
  const fields = { name: field('name'), addressLine1: field('street'), addressLine2: field('unit'), addressLine3: field('floor'), city: field('city'),
    districtOrCounty: field('county'), stateOrRegion: field('state'), postalCode: `${postalCore} ${hex(3).toUpperCase()}` };
  const values = Object.values(fields);
  const cores = values.map((value) => value.startsWith(postalCore) ? postalCore : value.split(' ')[1]!);
  return { fields, tokens: [...values, ...cores], postalTokens: [fields.postalCode, postalCore] };
}

function base64Runs(token: string, url: boolean): string[] {
  const bytes = Buffer.from(token, 'utf8');
  const runs: string[] = [];
  for (let skip = 0; skip < 3; skip += 1) {
    const whole = Math.floor((bytes.length - skip) / 3) * 3;
    if (whole >= 9) runs.push(bytes.subarray(skip, skip + whole).toString(url ? 'base64url' : 'base64'));
  }
  return runs;
}

function needles(token: string): { encoding: Encoding; form: string; folded: boolean }[] {
  if (token.length < 11) throw new Error('a canary token is too short to be unique');
  const percent = encodeURIComponent(token);
  const cased = [...new Set([token, token.toUpperCase(), token.toLowerCase()])];
  const hexForm = Buffer.from(token, 'utf8').toString('hex');
  return [
    { encoding: 'plain', form: token, folded: false },
    { encoding: 'casefold', form: token.toLowerCase(), folded: true },
    ...cased.flatMap((variant) => base64Runs(variant, false)).map((form) => ({ encoding: 'base64' as const, form, folded: false })),
    ...cased.flatMap((variant) => base64Runs(variant, true)).map((form) => ({ encoding: 'base64url' as const, form, folded: false })),
    { encoding: 'hex', form: hexForm, folded: true },
    { encoding: 'hex', form: hexForm.replace(/(..)(?!$)/g, '$1 '), folded: true },
    { encoding: 'url', form: percent.toLowerCase(), folded: true },
    { encoding: 'url', form: percent.replace(/%20/g, '+').toLowerCase(), folded: true },
  ];
}

function encode(text: string, encoding: Encoding): string {
  switch (encoding) {
    case 'plain': return text;
    case 'casefold': return text.toUpperCase();
    case 'base64': return Buffer.from(text).toString('base64');
    case 'base64url': return Buffer.from(text).toString('base64url');
    case 'hex': return Buffer.from(text).toString('hex').toUpperCase();
    case 'url': return encodeURIComponent(text);
  }
}

function hits(tokens: readonly string[], text: string): Set<Encoding> {
  const folded = text.toLowerCase();
  const found = new Set<Encoding>();
  for (const needle of tokens.flatMap(needles)) if ((needle.folded ? folded : text).includes(needle.form)) found.add(needle.encoding);
  return found;
}

/** Fails naming the sinks that hold any token in any form; never the token, the encoding or the text. */
function assertNoCanary(tokens: readonly string[], sinks: Record<string, readonly string[]>): void {
  const leaking = Object.entries(sinks).filter(([, texts]) => texts.some((text) => hits(tokens, text).size > 0)).map(([sink]) => sink);
  if (leaking.length > 0) throw new Error(`recipient canary found in sink: ${leaking.join(', ')}`);
}

// ---------------------------------------------------------------------------
// The simulated MCF worker (the ledger's service-role functions; see creators-sample-send.spec.ts).
// ---------------------------------------------------------------------------

function publicKeyId(): string {
  const raw = process.env['OPENSPELL_MCF_RECIPIENT_PUBLIC_KEY'];
  if (raw === undefined) throw new Error('global setup did not set OPENSPELL_MCF_RECIPIENT_PUBLIC_KEY');
  return (JSON.parse(raw) as { keyId: string }).keyId;
}

function preflightDetail(sku: string, asin: string) {
  const readAt = new Date(Date.now() - 60_000).toISOString();
  return {
    computedScore: 10, checks: creatorPreflightChecks([], CreatorPreflightCheck.options.map((check) => ({ check, readAt, evidenceReference: `ev:e8-${check}` }))),
    sku, campaignId: 'campaign-e8', productTitle: 'Synthetic roller', trackerSourceRef: 'tracker row 401', quantity: 1, feeCents: 620, feeCapCents: 800,
    inventory: { asin, sku, fulfillmentChannel: 'AFN', mcfFulfillable: true, fulfillableQuantity: 37, checkedAt: readAt, evidenceReference: 'ev:e8-inventory' },
    preview: { operation: 'getFulfillmentPreview', readAt, validUntil: null, isFulfillable: true, feeCents: 620, currency: 'USD', constraints: [] },
  };
}

interface Scope { connection: string; marketplace: string; scope: string }
interface Restore { connections: { id: string; status: string; vault_secret_id: string | null }[]; bindings: { id: string; enabled: boolean }[] }

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

async function heartbeat(db: DbHandle, scope: Scope) {
  await asServiceRole(db, (sql) => sql`select app.record_creator_mcf_heartbeat('e2e-mcf-privacy', ${[scope.scope]}::text[], true, true, 'e2e-rev', null)`);
}

interface Claim {
  sendId: string; leaseId: string; sku: string; spapiConnectionId: string; marketplaceId: string; envelopeSha256: string; keyId: string;
  binding: { derivedOrderKey: string; reservationId: string; asin: string };
  preflight: { runId: string; completedAt: string };
  caps: { laneFeeCapMinor: number | null; grantFeeCapMinor: number | null; grantCurrency: string | null };
}

async function worker<T = Record<string, unknown>>(db: DbHandle, call: (sql: Parameters<Parameters<typeof asServiceRole>[1]>[0]) => Promise<{ result: T }[]>): Promise<T> {
  return asServiceRole(db, async (sql) => (await call(sql))[0]!.result);
}

async function claim(db: DbHandle, scope: Scope, sendId: string, action: 'preview' | 'dispatch' | 'cancel'): Promise<Claim> {
  const claimed = await worker<Claim | null>(db, (sql) => sql`select app.claim_creator_mcf_outbox('e2e-mcf-privacy', ${[scope.scope]}::text[],
    ${`{${action}}`}) as result`);
  if (claimed === null) throw new Error(`no ${action} work was due for the send`);
  expect(claimed.sendId).toBe(sendId);
  return claimed;
}

async function workerPreview(db: DbHandle, scope: Scope, sendId: string): Promise<CreatorMcfPreview> {
  const claimed = await claim(db, scope, sendId, 'preview');
  const readAt = new Date();
  const preview = CreatorMcfPreview.parse({
    previewId: randomUUID(), sendId, derivedOrderKey: claimed.binding.derivedOrderKey, reservationId: claimed.binding.reservationId,
    spapiConnectionId: claimed.spapiConnectionId, marketplaceId: claimed.marketplaceId, readAt: readAt.toISOString(),
    validUntil: new Date(readAt.getTime() + 30 * 60_000).toISOString(), workerRevision: 'e2e-rev', kind: 'preview',
    preflightRunId: claimed.preflight.runId, preflightCompletedAt: new Date(claimed.preflight.completedAt).toISOString(), asin: claimed.binding.asin,
    items: [{ sellerSku: claimed.sku, sellerFulfillmentOrderItemId: `${claimed.binding.derivedOrderKey}-1`, quantity: 1 }], totalUnits: 1,
    shippingSpeedCategory: 'Standard', fulfillmentAction: 'Ship', fulfillmentPolicy: 'FillOrKill', featureConstraints: [], existingOrder: 'none',
    isFulfillable: true, fees: { parts: [{ feeName: 'FBAPerUnitFulfillmentFee', amountMinor: 620 }], totalMinor: 620, currency: 'USD' },
    unfulfillableReasons: [], earliestArrivalDate: '2026-10-02', latestArrivalDate: '2026-10-05',
    laneFeeCapMinor: claimed.caps.laneFeeCapMinor, grantFeeCapMinor: claimed.caps.grantFeeCapMinor, grantCurrency: claimed.caps.grantCurrency,
    envelopeSha256: claimed.envelopeSha256, keyId: claimed.keyId, irreversibility: CREATOR_MCF_IRREVERSIBILITY,
  });
  expect((await worker<{ decision: string }>(db, (sql) => sql`select app.record_creator_mcf_preview(${sendId}::uuid, ${claimed.leaseId}::uuid,
    ${creatorMcfCanonicalJson(preview)}) as result`)).decision).toBe('preview_ready');
  return preview;
}

/** The dispatch claim, the re-read (unchanged) and the reservation: the lease the POST's outcome is recorded under. */
async function reserveDispatch(db: DbHandle, scope: Scope, sendId: string, preview: CreatorMcfPreview): Promise<string> {
  const dispatch = await claim(db, scope, sendId, 'dispatch');
  const rereadAt = new Date();
  const reread = CreatorMcfPreview.parse({ ...preview, previewId: randomUUID(), kind: 'dispatch_reread', readAt: rereadAt.toISOString(),
    validUntil: new Date(rereadAt.getTime() + 30 * 60_000).toISOString() });
  expect((await worker<{ decision: string }>(db, (sql) => sql`select app.record_creator_mcf_preview(${sendId}::uuid, ${dispatch.leaseId}::uuid,
    ${creatorMcfCanonicalJson(reread)}) as result`)).decision).toBe('same');
  expect((await worker<{ decision: string }>(db, (sql) => sql`select app.reserve_creator_mcf_dispatch(${sendId}::uuid, ${dispatch.leaseId}::uuid,
    ${'e8'.repeat(32)}) as result`)).decision).toBe('dispatch_once');
  return dispatch.leaseId;
}

function orderRead(key: string, sku: string, status: string, readAt = new Date()) {
  return { outcome: 'found', operation: 'getFulfillmentOrder', status, readAt: readAt.toISOString(), sellerFulfillmentOrderId: key,
    items: [{ sellerSku: sku, quantity: 1, cancelledQuantity: 0, unfulfillableQuantity: 0 }], shipments: [], packages: [] };
}

// ---------------------------------------------------------------------------
// The browser's sinks.
// ---------------------------------------------------------------------------

interface Captured {
  actionBodies: string[]; actionResponses: string[]; html: string[]; rsc: string[]; console: string[]; pending: Promise<unknown>[];
  /** Action and RSC bodies Playwright could not read: each is a sink the scan would have missed, so the test requires none. */
  dropped: string[];
}

async function capture(page: Page): Promise<Captured> {
  const captured: Captured = { actionBodies: [], actionResponses: [], html: [], rsc: [], console: [], pending: [], dropped: [] };
  // Server actions go through the test: the request body as posted, and the whole response read before the page gets it,
  // so an action answered while the page navigates away is still scanned.
  await page.route((url) => url.origin === BASE_URL, async (route) => {
    const request = route.request();
    if (request.method() !== 'POST' || request.headers()['next-action'] === undefined) { await route.fallback(); return; }
    captured.actionBodies.push(request.postData() ?? '');
    let response;
    let body: Buffer;
    try {
      response = await route.fetch();
      body = await response.body();
    } catch {
      captured.dropped.push('action fetch');
      await route.abort();
      return;
    }
    captured.actionResponses.push(body.toString('utf8'));
    await route.fulfill({ response, body });
  });
  page.on('response', (response) => {
    if (new URL(response.url()).origin !== BASE_URL) return;
    const type = response.headers()['content-type'] ?? '';
    if (response.request().method() === 'POST' && response.request().headers()['next-action'] !== undefined) return;
    const into = type.includes('text/x-component') ? captured.rsc : type.includes('text/html') ? captured.html : null;
    if (into === null) return;
    const kind = into === captured.html ? 'html' : 'rsc';
    captured.pending.push(response.text().then((text) => { into.push(text); }, () => {
      // A navigation that abandons a document is not a sink; an unread action or RSC body is.
      if (kind !== 'html' || response.status() < 300 || response.status() >= 400) captured.dropped.push(`${kind} ${response.status()}`);
    }));
  });
  page.on('console', (message) => { captured.console.push(message.text()); });
  page.on('pageerror', (error) => { captured.console.push(`${error.name}: ${error.message}\n${error.stack ?? ''}`); });
  return captured;
}

interface Lane { record: string; asin: string; sku: string; reservation: string; key: string }

async function seedLane(db: DbHandle, org: string, record: string, asin: string, sku: string): Promise<Lane> {
  const reservation = `MCFR-${randomBytes(8).toString('hex').toUpperCase()}`;
  const key = `CCS-${createHash('sha256').update(`${org}|${record}|${asin}`).digest('hex').slice(0, 32)}`;
  await db.sql`insert into public.creator_records(org_id, creator_record_id, brand, campaign_id, storefront_fp, record_state, lock_state, runner_version,
      created_on, source, source_digest)
    values (${org}, ${record}, 'Synthetic brand', 'campaign-e8', ${createHash('sha256').update(`synthetic:e8:${record}`).digest('hex')},
      'Active', 'Unlocked', 1, '2026-09-01', 'control-runner', ${DIGEST}) on conflict do nothing`;
  await db.sql`insert into public.creator_sample_shipments(org_id, creator_record_id, asin, sku, campaign_id, reservation_id, lane_state, fee_cents,
      fee_cap_cents, reserved_at, source, source_digest)
    values (${org}, ${record}, ${asin}, ${sku}, 'campaign-e8', ${reservation}, 'Reserved', 620, 800, now() - interval '5 minutes', 'control-runner',
      ${DIGEST})`;
  await db.sql`insert into public.creator_sample_preflights(org_id, run_id, command, creator_record_id, asin, result, errors, required_next_state, detail,
      started_at, completed_at, source, source_digest)
    values (${org}, ${`e8-pass-${randomBytes(3).toString('hex')}`}, 'preflight', ${record}, ${asin}, 'PASS', '{}', 'Locked for MCF',
      ${JSON.stringify(preflightDetail(sku, asin))}::jsonb, now() - interval '65 seconds', now() - interval '60 seconds', 'control-runner', ${DIGEST})`;
  return { record, asin, sku, reservation, key };
}

/** Types the canary, checks it is on screen (the positive control), seals it and returns the DOM right after sealing and the send id. */
async function typeAndSeal(page: Page, db: DbHandle, org: string, lane: Lane, c: Canary) {
  await page.goto(`/creators/samples/${lane.key}/preflight`);
  await expect(page.getByTestId('address-form')).toBeVisible();
  for (const [field, value] of Object.entries(c.fields)) await page.locator(`[data-recipient-field="${field}"]`).fill(value);
  await page.getByTestId('review-address').click();
  await expect(page.getByTestId('review-record')).toHaveText(lane.record);
  // Positive control: the typing tab shows every field's token, and the scan finds each of them there.
  const typing = await page.content();
  for (const token of c.tokens) expect(hits([token], typing).has('plain'), 'a typed token on the review panel').toBe(true);
  await page.getByTestId('seal-address').click();
  await expect(page.locator('[data-testid="send-card"][data-send-state="sealed"]')).toBeVisible();
  await expect(page.locator('[data-recipient-field]')).toHaveCount(0);
  // The sealed card holds the typed postal code in this tab's memory by design: the only exception, and only until a reload.
  await expect(page.getByTestId('sealed-memory')).toContainText(c.postalTokens[0]!);
  const sealedDom = await page.content();
  const [send] = await db.sql<{ id: string; state: string }[]>`select id, state from public.creator_mcf_sends
    where org_id = ${org} and derived_order_key = ${lane.key} order by created_at desc limit 1`;
  expect(send?.state).toBe('sealed');
  return { sendId: send!.id, sealedDom };
}

/** Loads every screen that shows the lane or its send, and returns their DOMs after load. */
async function visitAll(page: Page, lane: Lane, state: string): Promise<string[]> {
  const doms: string[] = [];
  await page.goto(`/creators/samples/${lane.key}/preflight`);
  await expect(page.locator(`[data-testid="send-card"][data-send-state="${state}"]`)).toBeVisible({ timeout: 30_000 });
  doms.push(await page.content());
  for (const path of [`/creators/samples/fulfillment/${lane.key}`, '/creators/samples', '/sync-status']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    doms.push(await page.content());
  }
  return doms;
}

test('MCF privacy: a canary address sealed in the browser, sent, placed, cancelled and rejected leaves no token in any action body, HTML, RSC payload, log or table', async ({ page }) => {
  test.setTimeout(480_000);
  await page.setViewportSize({ width: 1440, height: 1024 });
  const state = await readState();
  const db = createDb({ connectionString: state.connectionString, max: 2 });
  const org = state.orgId;
  const admin = { orgId: org, userId: USERS.admin };
  const { scope, restore } = await usableBinding(db, org);
  const canaries = [canary(), canary()];
  const tokens = canaries.flatMap((c) => c.tokens);
  const postal = canaries.flatMap((c) => c.postalTokens);
  const serverLog = resolve(tmpdir(), `oauth-next-${APP_PORT}.log`);
  const logStart = (await readFile(serverLog, 'utf8').catch(() => '')).length;
  try {
    const keyId = publicKeyId();
    await db.sql`update app.creator_mcf_grants set revoked_at = now() where org_id = ${org} and revoked_at is null`;
    await db.sql`insert into app.creator_mcf_grants(org_id, spapi_connection_id, marketplace_id, action_classes, recipient_key_ids, max_units_per_day,
        max_fee_minor, currency, enabled_by, enabled_at, expires_at)
      values (${org}, ${scope.connection}, ${scope.marketplace}, '{send,cancel}', ${[keyId]}::text[], 20, 1500, 'USD', 'synthetic e2e operator', now(),
        now() + interval '1 day')`;
    await heartbeat(db, scope);
    const placedLane = await seedLane(db, org, 'CCR-E8-26-0401', 'B0E8PRV401', 'SW-E8-01-FBA');
    const rejectedLane = await seedLane(db, org, 'CCR-E8-26-0402', 'B0E8PRV402', 'SW-E8-02-FBA');
    await db.sql`insert into public.creator_import_runs(org_id, started_at, finished_at, status, files, counts, source)
      values (${org}, clock_timestamp(), clock_timestamp(), 'succeeded', '{registry,preflight_results}', ${COUNTS}::jsonb, 'control-runner')`;

    const captured = await capture(page);
    const sealedDoms: string[] = [];
    const doms: string[] = [];
    const visited: string[] = [];
    await signIn(page, 'admin');

    // Lane one: seal, preview, "Send 1 unit via Amazon", 200, placed, then the guarded cancel to Cancelled.
    const one = await typeAndSeal(page, db, org, placedLane, canaries[0]!);
    sealedDoms.push(one.sealedDom);
    const preview = await workerPreview(db, scope, one.sendId);
    await expect(page.locator('[data-testid="send-card"][data-send-state="preview_ready"]')).toBeVisible({ timeout: 30_000 });
    sealedDoms.push(await page.content());
    await page.reload();
    await expect(page.getByTestId('sealed-memory')).toHaveCount(0);
    doms.push(await page.content());
    await page.getByTestId('send-button').click();
    await expect(page.locator('[data-testid="send-card"][data-send-state="approved"]')).toBeVisible();
    doms.push(...await visitAll(page, placedLane, 'approved'));
    visited.push('approved');
    const lease = await reserveDispatch(db, scope, one.sendId, preview);
    expect(await worker(db, (sql) => sql`select app.record_creator_mcf_outcome(${one.sendId}::uuid, ${lease}::uuid,
      '{"outcome":"accepted","status":200}'::jsonb, null) as result`)).toMatchObject({ state: 'accepted' });
    doms.push(...await visitAll(page, placedLane, 'accepted'));
    visited.push('accepted');
    expect(await worker(db, (sql) => sql`select app.record_creator_mcf_settlement(${one.sendId}::uuid,
      ${JSON.stringify(orderRead(placedLane.key, placedLane.sku, 'Received'))}::text::jsonb, null) as result`)).toMatchObject({ state: 'placed' });
    doms.push(...await visitAll(page, placedLane, 'placed'));
    visited.push('placed');

    await page.goto(`/creators/samples/${placedLane.key}/preflight`);
    await page.getByTestId('cancel-in-amazon').click();
    await expect(page.getByTestId('cancel-reading')).toBeVisible();
    const readClaim = await claim(db, scope, one.sendId, 'cancel');
    const readAt = new Date();
    const cancelPreview = CreatorMcfCancelPreview.parse({
      previewId: randomUUID(), sendId: one.sendId, derivedOrderKey: placedLane.key, reservationId: placedLane.reservation,
      spapiConnectionId: readClaim.spapiConnectionId, marketplaceId: readClaim.marketplaceId, readAt: readAt.toISOString(),
      validUntil: new Date(readAt.getTime() + 5 * 60_000).toISOString(), workerRevision: 'e2e-rev', kind: 'cancel_preview',
      existingOrder: { status: 'Received' }, items: [{ sellerSku: placedLane.sku, sellerFulfillmentOrderItemId: `${placedLane.key}-1`, quantity: 1 }],
      totalUnits: 1,
    });
    expect((await worker<{ decision: string }>(db, (sql) => sql`select app.record_creator_mcf_cancel_preview(${one.sendId}::uuid,
      ${readClaim.leaseId}::uuid, ${JSON.stringify(orderRead(placedLane.key, placedLane.sku, 'Received', readAt))}::text::jsonb,
      ${creatorMcfCanonicalJson(cancelPreview)}) as result`)).decision).toBe('cancel_preview_ready');
    await expect(page.getByTestId('cancel-preview')).toHaveAttribute('data-current', 'true', { timeout: 30_000 });
    doms.push(await page.content());
    await page.getByTestId('cancel-button').click();
    await expect(page.getByTestId('cancel-approved')).toBeVisible();
    const execute = await claim(db, scope, one.sendId, 'cancel');
    expect((await worker<{ decision: string }>(db, (sql) => sql`select app.reserve_creator_mcf_cancel(${one.sendId}::uuid, ${execute.leaseId}::uuid,
      ${JSON.stringify(orderRead(placedLane.key, placedLane.sku, 'Received'))}::text::jsonb, ${'c8'.repeat(32)}) as result`)).decision).toBe('cancel_once');
    await worker(db, (sql) => sql`select app.record_creator_mcf_cancel_outcome(${one.sendId}::uuid, ${execute.leaseId}::uuid,
      '{"outcome":"accepted","status":200}'::jsonb, null) as result`);
    doms.push(...await visitAll(page, placedLane, 'cancel_dispatching'));
    visited.push('cancel_dispatching');
    expect(await worker(db, (sql) => sql`select app.record_creator_mcf_settlement(${one.sendId}::uuid,
      ${JSON.stringify(orderRead(placedLane.key, placedLane.sku, 'Cancelled'))}::text::jsonb, null) as result`)).toMatchObject({ state: 'cancelled' });
    doms.push(...await visitAll(page, placedLane, 'cancelled'));
    visited.push('cancelled');

    // Lane two: seal, preview, approval, a 400 whose read finds nothing: rejected.
    const two = await typeAndSeal(page, db, org, rejectedLane, canaries[1]!);
    sealedDoms.push(two.sealedDom);
    const secondPreview = await workerPreview(db, scope, two.sendId);
    const [latest] = await db.sql<{ fingerprint: string }[]>`select fingerprint from public.creator_mcf_send_previews where id = ${secondPreview.previewId}`;
    expect((await approveCreatorMcfSend(db, admin, { sendId: two.sendId, previewId: secondPreview.previewId, previewFingerprint: latest!.fingerprint,
      totalUnits: 1, confirmation: 'Send 1 unit via Amazon', requestId: randomUUID() })).outcome).toBe('approved');
    const secondLease = await reserveDispatch(db, scope, two.sendId, secondPreview);
    doms.push(...await visitAll(page, rejectedLane, 'dispatching'));
    visited.push('dispatching');
    expect(await worker(db, (sql) => sql`select app.record_creator_mcf_outcome(${two.sendId}::uuid, ${secondLease}::uuid,
      '{"outcome":"rejected","status":400,"codes":["InvalidInput"],"reason":"validation"}'::jsonb,
      ${JSON.stringify({ outcome: 'not_found', operation: 'getFulfillmentOrder', readAt: new Date().toISOString() })}::text::jsonb) as result`))
      .toMatchObject({ state: 'rejected' });
    doms.push(...await visitAll(page, rejectedLane, 'rejected'));
    visited.push('rejected');
    expect(visited).toEqual(['approved', 'accepted', 'placed', 'cancel_dispatching', 'cancelled', 'dispatching', 'rejected']);

    // Custody is gone for both sends, and nothing is left behind.
    const [custody] = await db.sql<{ n: number }[]>`select count(*)::int as n from app.creator_mcf_recipient_custody where send_id in ${db.sql([one.sendId, two.sendId])}`;
    expect(custody?.n).toBe(0);
    const [residue] = await db.sql<{ expired_live: number; custody_free_live: number }[]>`select * from app.creator_mcf_custody_residue()`;
    expect(residue).toEqual({ expired_live: 0, custody_free_live: 0 });

    // A data-only export of every table in every non-system schema.
    const tables = await db.sql<{ schema: string; name: string }[]>`select n.nspname as schema, c.relname as name from pg_class c
      join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r', 'p') and not c.relispartition
        and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%' and n.nspname not like 'pg_temp%'`;
    const dump: string[] = [];
    const perTable = new Map<string, number>();
    for (const table of tables) {
      const ident = `"${table.schema.replace(/"/g, '""')}"."${table.name.replace(/"/g, '""')}"`;
      const rows = (await db.sql.unsafe<{ row: string }[]>(`select t::text as row from ${ident} t`)).map((row) => row.row);
      perTable.set(`${table.schema}.${table.name}`, rows.length);
      dump.push(...rows);
    }
    // The export is not filtered by row security, and the tables a leak would land in hold rows.
    const [role] = await db.sql<{ bypass: boolean }[]>`select rolsuper or rolbypassrls as bypass from pg_roles where rolname = current_user`;
    expect(role?.bypass, 'the export role reads every row').toBe(true);
    for (const table of ['public.creator_mcf_sends', 'public.creator_mcf_send_events', 'public.creator_mcf_send_previews', 'public.creator_mcf_outbox',
      'app.creator_mcf_cancels', 'app.creator_mcf_worker_heartbeats', 'public.creator_sample_shipments', 'public.creator_action_log']) {
      expect(perTable.get(table), table).toBeGreaterThan(0);
    }
    expect(tables.map((table) => `${table.schema}.${table.name}`)).toEqual(expect.arrayContaining(['public.creator_mcf_sends',
      'public.creator_mcf_send_events', 'app.creator_mcf_recipient_custody', 'app.creator_mcf_cancels', 'public.audit_log']));
    expect(dump.length).toBeGreaterThan(100);

    await Promise.allSettled(captured.pending);
    const serverOutput = (await readFile(serverLog, 'utf8')).slice(logStart);
    // Every sink was live: the seal posted two envelopes, the server rendered HTML and RSC, and the log file is being written.
    expect(captured.actionBodies.filter((body) => body.includes('"envelope"'))).toHaveLength(2);
    expect(captured.html.length).toBeGreaterThan(10);
    expect(captured.rsc.length).toBeGreaterThan(0);
    expect(captured.dropped, 'action and RSC bodies that could not be read').toEqual([]);
    expect(captured.actionResponses).toHaveLength(captured.actionBodies.length);
    expect(serverOutput).toContain(`/creators/samples/${placedLane.key}/preflight`);
    expect(serverOutput).toContain(`/creators/samples/${rejectedLane.key}/preflight`);
    // Positive control for the network sinks: a token spliced into a real action body is found in every encoding.
    const sample = captured.actionBodies.find((body) => body.includes('"envelope"'))!;
    for (const encoding of ENCODINGS) {
      const spliced = encode(`${sample.slice(0, 40)}${tokens[0]!}${sample.slice(40)}`, encoding);
      expect(hits(tokens, spliced).has(encoding), encoding).toBe(true);
    }

    assertNoCanary(tokens.filter((token) => !postal.includes(token)), { sealedTabDom: sealedDoms });
    assertNoCanary(tokens, {
      actionRequestBodies: captured.actionBodies,
      actionResponses: captured.actionResponses,
      htmlDocuments: captured.html,
      rscPayloads: captured.rsc,
      domAfterReload: doms,
      browserConsole: captured.console,
      webServerLog: [serverOutput],
      dataOnlyExport: dump,
    });
  } finally {
    await db.sql`update app.creator_mcf_grants set revoked_at = now() where org_id = ${org} and revoked_at is null`;
    await db.sql`delete from app.creator_mcf_worker_heartbeats where worker_id = 'e2e-mcf-privacy'`;
    for (const binding of restore.bindings) await db.sql`update public.spapi_profile_bindings set enabled = ${binding.enabled} where id = ${binding.id}`;
    for (const connection of restore.connections) {
      await asServiceRole(db, (sql) => sql`update public.spapi_connections set status = ${connection.status}, vault_secret_id = ${connection.vault_secret_id}
        where id = ${connection.id}`);
    }
    await db.close();
  }
});
