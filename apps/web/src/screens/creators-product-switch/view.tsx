import type { ReactNode } from 'react';
import {
  CREATOR_PREFLIGHT_CHECK_LABELS, type CreatorInventoryRead, type CreatorProductSwitchDetail, type CreatorSamplePreflight,
  type CreatorSwitchPreflight,
} from '@wizard-ads/shared';
import { Badge, Button, EmptyState, TableFrame } from '../../ui/primitives';
import { formatShellDate, formatTimestamp } from '../../ui/date-format';
import {
  CreatorGated, CreatorHeader, CreatorLoadError, ImportRefusal, LockBadge, SectionHead, count, lastRead,
} from '../creators-daily-queue/creator-frame';
import { ACTION_LABEL } from '../creators-daily-queue/queue-summary';
import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;

const TITLE = 'Product switch';
const GATE_TONE = { BLOCKED: 'bad', HOLD: 'warn', PENDING_APPROVAL: 'info' } as const;

/** `original_unavailable_reason` in words. */
export const ORIGINAL_REASON_WORDS: Record<NonNullable<CreatorSwitchPreflight['originalUnavailableReason']>, string> = {
  not_mcf_fulfillable: 'The original SKU is not MCF-fulfillable, so Amazon cannot ship it as a sample.',
  out_of_stock: 'The original has no fulfillable unit in stock.',
  not_found: 'The original was not found in the inventory read.',
};

/** What happened to an alternate: a PASS is offered; a hold waits on something missing; a fail is two sources disagreeing. */
export type Disposition = 'offered' | 'held' | 'disagreement';
export const disposition = (alternate: CreatorSwitchPreflight): Disposition =>
  alternate.result === 'PASS' ? 'offered' : alternate.outcome === 'fail' ? 'disagreement' : 'held';
const DISPOSITION_BADGE = {
  offered: { tone: 'good', words: 'offered' },
  held: { tone: 'warn', words: 'excluded: held' },
  disagreement: { tone: 'bad', words: 'excluded: sources disagree' },
} as const;

const recordHref = (id: string) => `/creators/records/${id}`;
const preflightHref = (key: string) => `/creators/samples/${key}/preflight`;
const units = (read: CreatorInventoryRead | null) => read?.fulfillableQuantity == null
  ? <span className="wa-page-sub" data-units="not-read">not read</span>
  : <span data-units={String(read.fulfillableQuantity)}>{count(read.fulfillableQuantity)} {read.fulfillableQuantity === 1 ? 'unit' : 'units'}</span>;
const checkedAt = (value: string | null) => value === null
  ? <span className="wa-page-sub" data-time="not-read">not read</span> : formatTimestamp(value);
const mcfWords = (value: boolean | null) => value === null ? 'not read' : value ? 'yes' : 'no';
const Codes = ({ codes }: { codes: readonly string[] }) => codes.length === 0 ? <span className="wa-page-sub">none</span>
  : <>{codes.map((code, index) => <span key={code}>{index === 0 ? '' : ', '}<code data-code={code}>{code}</code></span>)}</>;

/** The offered alternate: the first PASS, which the read already sorts first. */
const offeredOf = (detail: CreatorProductSwitchDetail) => detail.alternates.find((alternate) => alternate.result === 'PASS') ?? null;

function Subtitle({ detail }: { detail: CreatorProductSwitchDetail }) {
  // The newest switch pre-flight's phase: the alternates are sorted offered first, not by time.
  const phase = [...detail.alternates].sort((left, right) => Date.parse(right.completedAt) - Date.parse(left.completedAt))[0]?.phase ?? null;
  return <>{detail.creatorRecordId} · <span data-testid="switch-status">{detail.status ?? <span className="wa-page-sub">status not reported</span>}</span>
    {' '}· <LockBadge lock={detail.lockState} />{detail.lockState === 'Unlocked' ? 'Unlocked' : detail.lockState === null ? 'lock not recorded' : null}
    {phase === null ? null : <> · phase {phase}</>} · {lastRead(detail.lastImport)}</>;
}

function QueueRow({ detail }: { detail: CreatorProductSwitchDetail }) {
  const item = detail.queueItem;
  if (item === null) return <span className="wa-page-sub" data-testid="queue-none">The newest queue run did not name this record.</span>;
  return <span data-testid="queue-item" data-action={item.actionType}>{ACTION_LABEL[item.actionType]} · <Badge tone={GATE_TONE[item.gateResult]}>{item.gateResult}</Badge>
    {' '}· due {formatShellDate(item.dueDate)}</span>;
}

function Header({ detail, withQueue }: { detail: CreatorProductSwitchDetail; withQueue: boolean }) {
  return <CreatorHeader title={TITLE} subtitle={detail.creatorRecordId === null ? <>Creator Connections · {lastRead(detail.lastImport)}</> : <Subtitle detail={detail} />}>
    <span className="wa-page-sub">Original lane <code data-testid="order-key" title="SHA-256 over organisation, creator record and ASIN; no date">{detail.derivedOrderKey}</code></span>
    {withQueue && detail.creatorRecordId !== null ? <QueueRow detail={detail} /> : null}
  </CreatorHeader>;
}

function Links({ detail }: { detail: CreatorProductSwitchDetail }) {
  return <p className="wa-page-sub" data-testid="switch-links"><a href="/creators/samples">Sample shipments</a>
    {detail.creatorRecordId === null ? null : <> · <a href={recordHref(detail.creatorRecordId)}>Record {detail.creatorRecordId}</a></>}
    {' '}· <a href={preflightHref(detail.derivedOrderKey)}>The original lane&apos;s pre-flight</a></p>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <><dt className="wa-page-sub">{label}</dt><dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{children}</dd></>;
}

function FromPreflight({ preflight }: { preflight: CreatorSamplePreflight }) {
  const stock = preflight.checks.find((check) => check.check === 'fulfillable_stock')!;
  const others = preflight.checks.filter((check) => check.check !== 'fulfillable_stock' && check.outcome !== 'pass');
  const read = preflight.inventory;
  return <div data-testid="original-source" data-source="preflight" className="wa-stack">
    <p data-testid="original-stock-check" data-outcome={stock.outcome}>
      <Badge tone={stock.outcome === 'pass' ? 'good' : stock.outcome === 'fail' ? 'bad' : 'warn'}>{stock.outcome}</Badge>{' '}
      {CREATOR_PREFLIGHT_CHECK_LABELS.fulfillable_stock}. Reason codes: <Codes codes={stock.reasons} />.</p>
    <dl data-testid="original-inventory" style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.25rem 1.5rem', margin: 0 }}>
      <Row label="ASIN"><code>{read?.asin ?? preflight.asin}</code></Row>
      <Row label="SKU">{read?.sku ?? preflight.sku ?? <span className="wa-page-sub">not recorded</span>}</Row>
      {read === null
        ? <Row label="Stock read"><span className="wa-page-sub" data-testid="original-inventory-none">No stock read was recorded with this pre-flight.</span></Row>
        : <>
          <Row label="Channel">{read.fulfillmentChannel ?? <span className="wa-page-sub">not read</span>}</Row>
          <Row label="MCF-fulfillable"><span data-testid="original-mcf">{mcfWords(read.mcfFulfillable)}</span></Row>
          <Row label="Fulfillable units"><span data-testid="original-units">{units(read)}</span></Row>
          <Row label="Checked">{checkedAt(read.checkedAt)} · {read.evidenceReference ?? <span className="wa-page-sub">no evidence reference</span>}</Row>
        </>}
    </dl>
    <p className="wa-page-sub">Pre-flight {preflight.runId}: {preflight.result}, completed {formatTimestamp(preflight.completedAt)}.
      {others.length === 0 ? null : <> Other checks not passing: {others.map((check) => check.check.replaceAll('_', ' ')).join(', ')}.</>}</p>
  </div>;
}

function WhyOriginal({ detail }: { detail: CreatorProductSwitchDetail }) {
  const blocker = detail.alternates.find((alternate) => alternate.originalUnavailableReason !== null) ?? null;
  return <section aria-label="Why the original cannot ship" data-testid="why-original" className="wa-stack">
    <SectionHead title="Why the original cannot ship" />
    {detail.originalPreflight !== null
      ? <FromPreflight preflight={detail.originalPreflight} />
      : blocker !== null
        ? <div data-testid="original-source" data-source="switch-preflight">
          <p><code>{blocker.originalAsin}</code>: <span data-testid="original-reason" data-reason={blocker.originalUnavailableReason}>
            {ORIGINAL_REASON_WORDS[blocker.originalUnavailableReason!]}</span></p>
          <p className="wa-page-sub">As the switch pre-flight recorded it; no sample pre-flight on the original lane is recorded. Evidence:{' '}
            {blocker.originalBlockerEvidenceReference ?? 'no evidence reference recorded'}.</p>
        </div>
        : <p className="wa-page-sub" data-testid="original-source" data-source="not-recorded">The reason the original cannot ship is not recorded:
          no sample pre-flight on the original lane, and no switch pre-flight named one.</p>}
  </section>;
}

function Candidates({ alternates }: { alternates: readonly CreatorSwitchPreflight[] }) {
  const offered = alternates.filter((alternate) => alternate.result === 'PASS').length;
  return <section aria-label="Alternates checked in live stock" data-testid="switch-candidates" className="wa-stack">
    <SectionHead title="Every candidate was checked in live stock">
      {count(alternates.length)} checked · {count(offered)} offered · {count(alternates.length - offered)} excluded</SectionHead>
    <TableFrame><table className="wa-table">
      <thead><tr><th>Alternate</th><th>SKU</th><th className="wa-num" data-numeric="true">Fulfillable</th><th>Channel</th><th>Checked</th><th>Phase</th><th>Result</th></tr></thead>
      <tbody>{alternates.map((alternate) => {
        const kind = disposition(alternate);
        return <tr key={alternate.alternateAsin} data-testid="switch-candidate" data-asin={alternate.alternateAsin} data-disposition={kind}
          data-outcome={alternate.outcome}>
          <td><code>{alternate.alternateAsin}</code></td>
          <td>{alternate.alternateSku ?? <span className="wa-page-sub">SKU not recorded</span>}</td>
          <td className="wa-num" data-numeric="true">{units(alternate.inventory)}</td>
          <td>{alternate.inventory?.fulfillmentChannel ?? <span className="wa-page-sub">not read</span>}</td>
          <td>{checkedAt(alternate.inventory?.checkedAt ?? null)}</td>
          <td>{alternate.phase}</td>
          <td><Badge tone={DISPOSITION_BADGE[kind].tone} data-disposition={kind}>{DISPOSITION_BADGE[kind].words}</Badge>
            {alternate.errors.length === 0 ? null : <><br /><span style={{ overflowWrap: 'anywhere' }}><Codes codes={alternate.errors} /></span></>}</td>
        </tr>;
      })}</tbody>
    </table></TableFrame>
    {offered === 0 ? <p className="wa-banner wa-banner--warn" data-testid="none-offered" style={{ display: 'block' }}>
      No alternate cleared every check, so none can be offered.</p> : null}
    <p className="wa-page-sub">Held: something was missing or not yet true, such as stock or a reference. Sources disagree: two records
      name different things, and a person has to look before the alternate can be considered again.</p>
  </section>;
}

/** Replies that acknowledge without naming an ASIN: none of them confirms a switch. */
export const DOES_NOT_COUNT = ['Sure, sounds good.', 'Ok!', 'Whatever you have is fine.'] as const;

function Acknowledgement({ asin }: { asin: string | null }) {
  const named = asin ?? '[the alternate ASIN]';
  return <section aria-label="An acknowledgement is not a confirmation" data-testid="acknowledgement" className="wa-banner wa-banner--warn" style={{ display: 'block' }}>
    <strong>An acknowledgement is not a confirmation.</strong>
    <p data-testid="counts">Counts: <span data-quote="counts">“Yes, {named} works for me.”</span></p>
    <p data-testid="does-not-count">Does not count: {DOES_NOT_COUNT.map((quote, index) => <span key={quote}>{index === 0 ? '' : ' · '}<span data-quote="does-not-count">“{quote}”</span></span>)}</p>
    <p>The reply has to name the alternate ASIN. Once it does, the ten checks are recomputed and the full pre-flight runs again for the
      alternate: a switch does not inherit the original&apos;s passes.</p>
  </section>;
}

function ConfirmControl({ asin }: { asin: string | null }) {
  return <section aria-label="Confirm the switch" data-testid="confirm-switch" className="wa-stack">
    <p className="wa-row"><Button disabled aria-describedby="confirm-switch-reason" data-testid="confirm-switch-button">Confirm the switch</Button>
      <span id="confirm-switch-reason" className="wa-page-sub">Confirming a switch is not built in this round, and it would need a reply
        naming {asin ?? 'the alternate ASIN'} on the record first.</span></p>
    <p className="wa-page-sub" data-testid="nothing-sent">Nothing was ordered, reserved or sent from Arcana.</p>
  </section>;
}

function ReadySwitch({ detail }: { detail: CreatorProductSwitchDetail }) {
  const refused = detail.lastImport?.status === 'failed';
  const frame = (children: ReactNode, state: string) => <main className="wa-stack" data-testid="creator-product-switch"
    data-key={detail.derivedOrderKey} data-switch-state={state}>
    <Header detail={detail} withQueue={!refused} />
    {children}
    <Links detail={detail} />
  </main>;
  if (refused) {
    return frame(<ImportRefusal run={detail.lastImport!}
      withheld="The original lane's blocker and the alternates are not shown, because they would read as current." />, 'refused');
  }
  if (detail.creatorRecordId === null) {
    return frame(<EmptyState variant="empty" data-creator-state="switch-empty" title="Nothing carries this key"
      body={<>No sample lane, sample pre-flight or switch pre-flight in this organisation carries the order key {detail.derivedOrderKey}.</>} />, 'empty');
  }
  if (detail.alternates.length === 0) {
    return frame(<>
      {detail.originalPreflight === null ? null : <WhyOriginal detail={detail} />}
      <EmptyState variant="not-measured" data-creator-state="switch-not-measured" title="Not measured"
        body={<>No product-switch pre-flight is recorded for this lane, so which alternates would clear live stock is not measured.
          It is not the same as no alternates.</>}
        meta="The runner's preflight-switch command records one per alternate ASIN." />
    </>, 'not-measured');
  }
  const offered = offeredOf(detail);
  return frame(<>
    <p className="wa-banner wa-banner--warn" data-testid="active-asin-banner" style={{ display: 'block' }}>
      <strong>The active ASIN has not moved.</strong> {detail.originalAsin ?? 'The original ASIN'} stays the active ASIN on this record.
      Until a reply names the alternate ASIN explicitly, nothing is switched; a generic acknowledgement is not a confirmation.</p>
    <WhyOriginal detail={detail} />
    <Candidates alternates={detail.alternates} />
    <Acknowledgement asin={offered?.alternateAsin ?? null} />
    <ConfirmControl asin={offered?.alternateAsin ?? null} />
  </>, 'ready');
}

export default function Screen({ data }: { data: ScreenData }) {
  switch (data.view) {
    case 'ready': return <ReadySwitch detail={data.props.detail} />;
    case 'missing': return <main className="wa-stack" data-testid="creator-product-switch"><CreatorHeader title={TITLE} subtitle="Creator Connections" />
      <EmptyState variant="empty" data-creator-state="key-missing" title="No such sample order key"
        body={data.props.key === null ? 'This address does not name a sample order key.' : `No sample order key ${data.props.key} is known.`}
        action={<a href="/creators/samples">Sample shipments</a>} /></main>;
    case 'gated': return <main className="wa-stack"><CreatorHeader title={TITLE} subtitle="Creator Connections" /><CreatorGated /></main>;
    case 'error': return <CreatorLoadError title={TITLE} message={data.props.message} />;
  }
}
