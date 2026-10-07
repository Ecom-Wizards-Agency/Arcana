import {
  CREATOR_PREFLIGHT_CHECK_LABELS, CREATOR_PREVIEW_VALIDITY_MS, creatorPreviewExpired, type CreatorInventoryRead, type CreatorPreflightCheckResult,
  type CreatorPreflightDetail, type CreatorSamplePreflight,
} from '@wizard-ads/shared';
import type { ReactNode } from 'react';
import { Badge, EmptyState, TableFrame } from '../../ui/primitives';
import { formatShellDate, formatTimestamp } from '../../ui/date-format';
import {
  CreatorGated, CreatorHeader, CreatorLoadError, ImportRefusal, LockBadge, SectionHead, SOURCE_LABEL, count, lastRead,
} from '../creators-daily-queue/creator-frame';
import { clock, money } from './order-key';
import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;

const TITLE = 'Sample pre-flight';
const ORDINAL = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'] as const;
/** pass: the check holds. hold: something is missing or not yet true. fail: two sources disagree. */
const OUTCOME_WORDS = { pass: 'holds', hold: 'does not', fail: 'disagrees' } as const;
const OUTCOME_TONE = { pass: 'good', hold: 'bad', fail: 'bad' } as const;

/**
 * How a check reads on screen: its outcome, always. The runner runs all eight
 * checks every time (creator_control.py mcf_preflight never stops early), so a
 * passing check without a read time passed and only its time was not recorded.
 * Figma 446:313 draws it "not reached"; the data cannot support that claim.
 */
export type CheckState = CreatorPreflightCheckResult['outcome'];
export function checkState(check: CreatorPreflightCheckResult, _preflight: Pick<CreatorSamplePreflight, 'result'>): CheckState {
  return check.outcome;
}
const STATE_WORDS: Record<CheckState, string> = OUTCOME_WORDS;
const STATE_TONE: Record<CheckState, 'good' | 'bad' | 'neutral'> = OUTCOME_TONE;

const recordLink = (id: string) => <a href={`/creators/records/${id}`} data-record-link={id}>{id}</a>;
const notRecorded = <span className="wa-page-sub">not recorded</span>;

/** A merchant-fulfilled listing can be live and buyable while Amazon can fulfil none of it. */
export function merchantFulfilled(inventory: CreatorInventoryRead | null): boolean {
  if (inventory === null) return false;
  return inventory.mcfFulfillable === false || (inventory.fulfillmentChannel !== null && /mfn|merchant|default/i.test(inventory.fulfillmentChannel));
}

const yesNo = (value: boolean | null) => value === null ? 'not read' : value ? 'yes' : 'no';
const units = (inventory: CreatorInventoryRead | null) => inventory?.fulfillableQuantity == null ? 'not read' : count(inventory.fulfillableQuantity);

/** When the preview stops being current: the runner's own expiry, or Arcana's window after the read. */
export function previewValidity(preview: NonNullable<CreatorSamplePreflight['preview']>): { until: string; basis: string } {
  if (preview.validUntil !== null) return { until: preview.validUntil, basis: 'the expiry the runner recorded' };
  return {
    until: new Date(Date.parse(preview.readAt) + CREATOR_PREVIEW_VALIDITY_MS).toISOString(),
    basis: `${CREATOR_PREVIEW_VALIDITY_MS / 60_000} minutes after the read, since the runner recorded no expiry`,
  };
}

function feeAgainstCap(preflight: CreatorSamplePreflight): string {
  const currency = preflight.preview?.currency ?? null;
  if (preflight.feeCents === null) return `fee not recorded; cap ${money(preflight.feeCapCents, currency)}`;
  if (preflight.feeCapCents === null) return `${money(preflight.feeCents, currency)}; cap not recorded`;
  const within = preflight.feeCents <= preflight.feeCapCents ? 'within' : 'over';
  return `${money(preflight.feeCents, currency)}, ${within} the ${money(preflight.feeCapCents, currency)} cap`;
}

function StockRead({ inventory }: { inventory: CreatorInventoryRead | null }) {
  if (inventory === null) return <>No stock read recorded. Fulfillable units: not read.</>;
  return <>{inventory.sku ?? 'SKU not recorded'} · channel {inventory.fulfillmentChannel ?? 'not read'} · MCF-fulfillable {yesNo(inventory.mcfFulfillable)} ·
    {' '}<span data-testid="fulfillable-units">Fulfillable units: {units(inventory)}</span></>;
}

/** What the stored values say for one check, beside the runner's reason codes. */
function WhatWasRead({ check, preflight }: { check: CreatorPreflightCheckResult; preflight: CreatorSamplePreflight }) {
  const summary = (() => {
    switch (check.check) {
      case 'identity': return <>Resolved to {preflight.creatorRecordId}.</>;
      case 'qualification': return <>Score computed {preflight.computedScore} of 10.</>;
      case 'agreement': return <>{[preflight.creatorRecordId, preflight.campaignId ?? 'campaign not recorded', preflight.trackerSourceRef ?? 'row not recorded',
        preflight.asin, preflight.sku ?? 'SKU not recorded', preflight.productTitle ?? 'product not recorded'].join(' · ')}</>;
      case 'recipient': return preflight.recipientBound ? <>A complete recipient block is bound to a fingerprint.</> : <>No recipient block is bound.</>;
      case 'no_prior_sample': return null;
      case 'quantity_shipping_fee': return <>Quantity {preflight.quantity ?? 'not recorded'}. Standard shipping only. Fee {feeAgainstCap(preflight)}.</>;
      case 'fulfillable_stock': return <StockRead inventory={preflight.inventory} />;
      case 'form': return null;
    }
  })();
  return <>{check.reasons.length > 0
    ? <span data-testid="check-reasons">{check.reasons.map((code, index) => <span key={code}>{index ? ', ' : ''}<code>{code}</code></span>)}. </span>
    : <span className="wa-page-sub">No error from the runner. </span>}
  {summary}</>;
}

function Checks({ preflight }: { preflight: CreatorSamplePreflight }) {
  return <TableFrame><table className="wa-table" data-testid="preflight-checks">
    <thead><tr><th>Check</th><th>Holds?</th><th>What was read</th><th>Read at</th><th>Evidence</th></tr></thead>
    <tbody>{preflight.checks.map((check, index) => { const state = checkState(check, preflight); return <tr key={check.check} data-testid="preflight-check" data-check={check.check} data-outcome={state}>
      <td>{index + 1} · {CREATOR_PREFLIGHT_CHECK_LABELS[check.check]}</td>
      <td><Badge tone={STATE_TONE[state]}>{STATE_WORDS[state]}</Badge></td>
      <td style={{ overflowWrap: 'anywhere' }}><WhatWasRead check={check} preflight={preflight} /></td>
      <td>{check.readAt === null ? <span className="wa-page-sub" data-read="not-recorded">read time not recorded</span> : clock(check.readAt)}</td>
      <td>{check.evidenceReference === null ? <span className="wa-page-sub">none</span> : <code>{check.evidenceReference}</code>}</td>
    </tr>; })}</tbody>
  </table></TableFrame>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <><dt className="wa-page-sub">{label}</dt><dd style={{ margin: 0, fontWeight: 600 }}>{children}</dd></>;
}
const grid = { display: 'grid', gridTemplateColumns: 'minmax(10rem, max-content) 1fr', gap: '0.25rem 1.5rem', margin: 0 } as const;

function WhatThisWillDo({ preflight, expired }: { preflight: CreatorSamplePreflight; expired: boolean }) {
  return <section className="wa-card" data-testid="what-this-will-do"><div className="wa-card__body wa-stack">
    <SectionHead title={expired ? 'What this would have done' : 'What this will do'} />
    <dl style={grid}>
      <Row label="Creator record">{preflight.creatorRecordId}</Row>
      <Row label="Campaign">{preflight.campaignId ?? notRecorded}{preflight.trackerSourceRef ? ` · ${preflight.trackerSourceRef}` : ''}</Row>
      <Row label="Product">{preflight.productTitle ?? notRecorded}</Row>
      <Row label="ASIN and SKU">{preflight.asin} · {preflight.sku ?? notRecorded}</Row>
      <Row label="Quantity">{preflight.quantity === null ? notRecorded : `${preflight.quantity} ${preflight.quantity === 1 ? 'unit' : 'units'}`}</Row>
      <Row label="Shipping">Standard</Row>
      <Row label="Fee">{feeAgainstCap(preflight)}</Row>
      <Row label="Order id · derived"><code data-testid="order-key" title="SHA-256 over organisation, creator record and ASIN; no date">{preflight.derivedOrderKey}</code></Row>
    </dl>
  </div></section>;
}

function Preview({ preflight }: { preflight: CreatorSamplePreflight }) {
  const { preview } = preflight;
  if (preview === null) return <p className="wa-page-sub" data-testid="preview">No fulfillment preview is recorded with this run.</p>;
  const validity = previewValidity(preview);
  return <p className="wa-page-sub" data-testid="preview">The runner read getFulfillmentPreview at {clock(preview.readAt)}: {preview.isFulfillable ? 'fulfillable' : 'not fulfillable'},
    fee {money(preview.feeCents, preview.currency)}{preview.constraints.length ? `, constraints ${preview.constraints.join(', ')}` : ', no constraints'}.
    It is current until {formatTimestamp(validity.until)} ({validity.basis}).</p>;
}

function Recipient({ preflight }: { preflight: CreatorSamplePreflight }) {
  return <section className="wa-card" data-testid="recipient" data-bound={preflight.recipientBound ? 'true' : 'false'}><div className="wa-card__body wa-stack">
    <SectionHead title="Recipient" />
    <p style={{ margin: 0 }}>{preflight.recipientBound
      ? 'The runner bound a complete recipient block to a fingerprint.'
      : 'The runner bound no complete recipient block to a fingerprint, so check four cannot hold.'}</p>
    <p className="wa-page-sub" style={{ margin: 0 }}>Arcana holds fingerprints only. No name, address, email or phone is kept here, so none can be shown.</p>
  </div></section>;
}

function PlaceOrder() {
  return <p className="wa-page-sub" data-testid="place-order-note">
    <button type="button" className="wa-btn" disabled data-testid="place-order">Place order</button>{' '}
    Ordering is not built in this round. Nothing was ordered, reserved or sent from Arcana.</p>;
}

/** Why the order would be held: the first check that does not hold, and, at stock, the difference a live listing hides. */
function Held({ preflight, keyValue }: { preflight: CreatorSamplePreflight; keyValue: string }) {
  const index = preflight.checks.findIndex((check) => check.outcome !== 'pass');
  const first = preflight.checks[index];
  const stock = preflight.checks.find((check) => check.check === 'fulfillable_stock')!;
  const listingTrap = stock.outcome !== 'pass' && merchantFulfilled(preflight.inventory);
  return <>
    <section className="wa-banner wa-banner--bad" data-testid="preflight-held" data-check={first?.check} style={{ display: 'block' }}>
      {first === undefined
        ? <strong>Held, with no check named.</strong>
        : <strong>Held at check {ORDINAL[index]}: {first.reasons.join(', ') || first.check}</strong>}
      {' '}{count(preflight.checks.filter((check) => check.outcome !== 'pass').length)} of 8 checks do not hold. Nothing was ordered or reserved,
      and the record waits.
    </section>
    {stock.outcome !== 'pass' ? <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(20rem, 1fr))', gap: '1rem' }}>
      <section className="wa-card" data-testid="stock-read"><div className="wa-card__body wa-stack">
        <SectionHead title="The stock this gate reads" />
        <dl style={grid}>
          <Row label="SKU">{preflight.inventory?.sku ?? preflight.sku ?? notRecorded}</Row>
          <Row label="Fulfillment channel">{preflight.inventory?.fulfillmentChannel ?? 'not read'}</Row>
          <Row label="MCF-fulfillable">{yesNo(preflight.inventory?.mcfFulfillable ?? null)}</Row>
          <Row label="Fulfillable units"><span data-testid="held-units">{units(preflight.inventory)}</span></Row>
          <Row label="Checked">{preflight.inventory?.checkedAt ? formatTimestamp(preflight.inventory.checkedAt) : 'not recorded'}
            {preflight.inventory?.evidenceReference ? ` · ${preflight.inventory.evidenceReference}` : ''}</Row>
        </dl>
        {listingTrap ? <p style={{ margin: 0 }} data-testid="listing-trap">An active listing is not fulfillable stock. This SKU can be live and buyable while Amazon
          can fulfil none of it, because it is merchant-fulfilled or not MCF-fulfillable. The gate reads only the fulfillable units.</p> : null}
      </div></section>
      <section className="wa-card" data-testid="no-substitution"><div className="wa-card__body wa-stack">
        <SectionHead title="Substitution is not an available action" />
        <p style={{ margin: 0 }}>No control here swaps the ASIN, and a re-run cannot clear a structural hold. A different product is a product switch, agreed with the
          creator on its own screen.</p>
        <p style={{ margin: 0 }}><a href={`/creators/samples/${keyValue}/product-switch`} data-testid="product-switch-link">The product switch for this lane</a></p>
      </div></section>
    </div> : null}
  </>;
}

/** A pass whose preview expired no longer stands; a hold stays a hold, and its preview is only old. */
function Stale({ preflight }: { preflight: CreatorSamplePreflight }) {
  const preview = preflight.preview!;
  const validity = previewValidity(preview);
  const read = <>The fulfillment preview was read at {formatTimestamp(preview.readAt)} ({clock(preview.readAt)}) and was current until
    {' '}{formatTimestamp(validity.until)}, {validity.basis}.</>;
  if (preflight.result !== 'PASS') {
    return <p className="wa-page-sub" data-testid="preflight-hold-preview-expired">The preview this hold was judged with has expired. {read}
      {' '}A new pre-flight is needed before this lane can pass.</p>;
  }
  return <section className="wa-banner wa-banner--warn" data-testid="preflight-stale" data-creator-state="stale" style={{ display: 'block' }}>
    <strong>The preview expired, so nothing was sent.</strong>{' '}{read}
    {' '}Fee and stock are point-in-time, so this pass no longer stands: a new pre-flight is needed before any order.
  </section>;
}

function ReadyPreflight({ detail, now }: { detail: CreatorPreflightDetail; now: string }) {
  const { preflight, lastImport, derivedOrderKey } = detail;
  const record = detail.creatorRecordId;
  const run = preflight === null ? null : <> · run {preflight.runId} · {clock(preflight.startedAt)} to {clock(preflight.completedAt)}, {formatShellDate(preflight.completedAt.slice(0, 10))}</>;
  const head = <CreatorHeader title={TITLE} subtitle={<>{record ?? 'No record'} · {detail.asin ?? 'no ASIN'}{run} · {lastRead(lastImport)}</>}>
    <LockBadge lock={detail.lockState} />
    {preflight === null ? null : <Badge tone={preflight.result === 'PASS' ? 'good' : 'bad'} data-result={preflight.result}>{preflight.result}</Badge>}
  </CreatorHeader>;
  const links = <p className="wa-page-sub" data-testid="preflight-links"><a href="/creators/samples">Sample shipments</a>
    {record === null ? null : <> · {recordLink(record)}</>}
    {detail.lane === null ? null : <> · <a href={`/creators/samples/fulfillment/${derivedOrderKey}`}>The sample order ({detail.lane.laneState})</a></>}</p>;
  if (lastImport?.status === 'failed') {
    return <main className="wa-stack" data-testid="creator-preflight">{head}{links}
      <ImportRefusal run={lastImport} withheld="The pre-flight is not shown, because it would read as current." /></main>;
  }
  if (preflight === null) {
    if (record === null && detail.lane === null) {
      return <main className="wa-stack" data-testid="creator-preflight">{head}{links}
        <EmptyState variant="empty" data-creator-state="nothing-held" title="Nothing carries this key"
          body={<>No sample lane or pre-flight in this organisation carries <code>{derivedOrderKey}</code>.</>} /></main>;
    }
    return <main className="wa-stack" data-testid="creator-preflight">{head}{links}
      <EmptyState variant="not-measured" data-creator-state="no-preflight" title="No pre-flight recorded"
        body={<>No sample pre-flight is recorded for {record ?? 'this record'} and {detail.asin ?? 'this ASIN'}, so it has neither passed nor been held.</>}
        meta="The runner's pre-flight arrives through creators.preflight_result or the pre-flight results file." /></main>;
  }
  const expired = creatorPreviewExpired(preflight.preview, new Date(now));
  const passed = preflight.result === 'PASS';
  const unread = preflight.checks.filter((check) => check.readAt === null).length;
  return <main className="wa-stack" data-testid="creator-preflight" data-result={preflight.result} data-expired={expired ? 'true' : 'false'}>
    {head}{links}
    {passed && !expired ? <section className="wa-banner wa-banner--good" data-testid="preflight-pass" style={{ display: 'block' }}>
      <strong>All eight checks held in run {preflight.runId}, at the times shown.</strong>{' '}
      A check carried over from an earlier run is not a pass. The run read between {clock(preflight.startedAt)} and {clock(preflight.completedAt)}
      {unread > 0 ? `; ${count(unread)} ${unread === 1 ? 'check has' : 'checks have'} no read time recorded` : ''}.
    </section> : null}
    {expired ? <Stale preflight={preflight} /> : null}
    {passed ? null : <Held preflight={preflight} keyValue={derivedOrderKey} />}
    <Checks preflight={preflight} />
    <Preview preflight={preflight} />
    <Recipient preflight={preflight} />
    {passed ? <WhatThisWillDo preflight={preflight} expired={expired} /> : null}
    <PlaceOrder />
    <p className="wa-page-sub" data-testid="preflight-provenance">Recorded {formatTimestamp(preflight.recordedAt)} from the {SOURCE_LABEL[preflight.source]}.
      {detail.earlierRuns > 0 ? ` ${count(detail.earlierRuns)} earlier ${detail.earlierRuns === 1 ? 'run is' : 'runs are'} recorded for this lane; only the newest is shown, and none of their checks carry over.` : ''}</p>
  </main>;
}

export default function Screen({ data }: { data: ScreenData }) {
  switch (data.view) {
    case 'ready': return <ReadyPreflight detail={data.props.detail} now={data.props.now} />;
    case 'missing': return <main className="wa-stack" data-testid="creator-preflight"><CreatorHeader title={TITLE} subtitle="Creator Connections" />
      <EmptyState variant="empty" data-creator-state="key-missing" title="No such sample order key"
        body="This address does not name a sample order key." action={<a href="/creators/samples">Sample shipments</a>} /></main>;
    case 'gated': return <main className="wa-stack"><CreatorHeader title={TITLE} subtitle="Creator Connections" /><CreatorGated /></main>;
    case 'error': return <CreatorLoadError title={TITLE} message={data.props.message} />;
  }
}
