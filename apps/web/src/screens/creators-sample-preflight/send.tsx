'use client';

/**
 * The sample send section (WP-338g): the address form, the review panel, the
 * browser seal, the sealed card, Arcana's preview card with "Send N unit(s) via
 * Amazon", Withdraw, and every send state after it.
 *
 * Address custody in this file:
 *  - The form renders only after hydration. Its inputs have no `name`, have
 *    autocomplete off and sit in no <form>, so no native submit, URL, history
 *    entry or autofill store can carry what is typed.
 *  - "Seal address" seals the typed block to the MCF worker's public key with
 *    WebCrypto, clears the form, and posts only {binding, envelope}.
 *  - The recipient's initials and full postal code stay in this module's memory
 *    for the sealed card until the tab closes. Nothing is written to storage,
 *    logged, or sent anywhere else. There is no reveal control: to correct an
 *    address the operator types it again.
 */
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import {
  CREATOR_MCF_IRREVERSIBILITY, CREATOR_MCF_RECIPIENT_FIELDS, CreatorMcfRecipient, creatorMcfEnvelopeSupported,
  creatorMcfRecipientIssues, creatorMcfSendConfirmation, sealCreatorMcfRecipient, type CreatorMcfRecipientBinding, type CreatorMcfRecipientField,
  type CreatorMcfRecipientIssue, type CreatorMcfSendPreview, type CreatorPreflightDetail,
} from '@wizard-ads/shared';
import type { CreatorMcfLaneSend, CreatorMcfLaneView } from '@wizard-ads/db';
import { Badge, TableFrame } from '../../ui/primitives';
import { formatTimestamp } from '../../ui/date-format';
import type { SendActionFailure, SendActionResult } from './send-actions';
import { approveMcfCancel, requestMcfCancelPreview } from './cancel-actions';
import { CancelControls, CancelProgress, cancelPhase, cancelWaiting, type CancelActions } from './cancel';
import {
  MISSING_WORDS, REFUSAL_WORDS, SEND_STATE_WORDS, STATE_REASON_WORDS, SUPERSEDABLE, WAITING, WITHDRAWABLE, arrivalEvent, codeWords, hhmm,
  initialsOf, issueWords, laneBlock, maskText, mayTakeAddress, minor, previewCurrent, sealBinding, sendingMissing, type LaneBlock, type SendData,
  type SendKey, type SendMissing,
} from './send-model';

/**
 * The server actions the page passes in. Tests pass fakes. The two cancel
 * actions are optional: when the page passes none, the section supplies the
 * real ones from ./cancel-actions.
 */
export interface SendActions extends Partial<CancelActions> {
  seal(body: unknown): Promise<SendActionResult>;
  approve(approval: unknown): Promise<SendActionResult>;
  withdraw(sendId: unknown): Promise<SendActionResult>;
  refresh(sendId: unknown): Promise<SendActionResult>;
  settleRead(sendId: unknown): Promise<SendActionResult>;
  release(sendId: unknown): Promise<SendActionResult>;
  resolveConflict(sendId: unknown, requestId: unknown): Promise<SendActionResult>;
}

/** Initials and full postal code per send, in this tab's memory only. */
const sealedInTab = new Map<string, { initials: string; postalCode: string }>();
/** Test seam: forget what this tab remembers. */
export function forgetSealedInTab(): void { sealedInTab.clear(); }

const REFRESH_MS = 5_000;
/** While a preview waits for the press, the page re-reads its clock and the gate this often, so an expired preview or a stale heartbeat hides the button. */
const READY_REFRESH_MS = 30_000;
const grid = { display: 'grid', gridTemplateColumns: 'minmax(10rem, max-content) 1fr', gap: '0.25rem 1.5rem', margin: 0 } as const;
const row = { display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' } as const;

function Row({ label, children, fact }: { label: string; children: ReactNode; fact?: string }) {
  return <><dt className="wa-page-sub">{label}</dt><dd style={{ margin: 0, fontWeight: 600, overflowWrap: 'anywhere' }} data-fact={fact}>{children}</dd></>;
}

function Card({ title, testid, children }: { title: string; testid: string; children: ReactNode }) {
  return <section className="wa-card" data-testid={testid} aria-label={title}><div className="wa-card__body wa-stack">
    <h2 className="wa-card__title" style={{ margin: 0 }}>{title}</h2>{children}
  </div></section>;
}

// ---------------------------------------------------------------------------
// Sending on or off
// ---------------------------------------------------------------------------

function SendingStatus({ missing, data }: { missing: readonly SendMissing[]; data: SendData }) {
  const beat = data.gate?.heartbeat ?? null;
  if (missing.length === 0) {
    return <p className="wa-page-sub" data-testid="sending-status" data-sending="on" style={{ margin: 0 }}>
      <Badge tone="good">Sending on</Badge>{' '}Grant active until {formatTimestamp(data.gate!.expiresAt)}; the MCF worker last reported at
      {' '}{beat === null ? 'no time' : hhmm(beat.beatAt)} with previews and dispatch on.</p>;
  }
  return <section className="wa-banner wa-banner--warn" data-testid="sending-off" data-sending="off" style={{ display: 'block' }}>
    <strong>Sending is off, so there is no Send button.</strong>{' '}Sending needs every one of these, and {missing.length === 1 ? 'this one is' : 'these are'} missing:
    <ul style={{ margin: '0.25rem 0 0', paddingLeft: '1.25rem' }}>{missing.map((item) => <li key={item} data-missing={item}>{MISSING_WORDS[item]}
      {item === 'heartbeat' ? ` Last heartbeat: ${beat === null ? 'never' : formatTimestamp(beat.beatAt)}.` : ''}</li>)}</ul>
  </section>;
}

// ---------------------------------------------------------------------------
// Address entry, review and seal
// ---------------------------------------------------------------------------

type Fields = Record<CreatorMcfRecipientField, string>;
const LABEL: Record<CreatorMcfRecipientField, string> = {
  name: 'Name', addressLine1: 'Address line 1', addressLine2: 'Address line 2 (optional)', addressLine3: 'Address line 3 (optional)', city: 'City',
  districtOrCounty: 'District or county (optional)', stateOrRegion: 'State or region', postalCode: 'Postal code', countryCode: 'Country',
};
/** The destination countries of the grant's marketplace. 3b ships for the US marketplace. */
const MARKETPLACE_COUNTRIES: Record<string, readonly string[]> = {
  ATVPDKIKX0DER: ['US'], A2EUQ1WTGCTBG2: ['CA'], A1AM78C64UM0Y8: ['MX'], A1F83G8C2ARO7P: ['GB'], A1PA6795UKMFR9: ['DE'], A13V1IB3VIYZZH: ['FR'],
  APJ6JRA9NG5V4: ['IT'], A1RKKUPIHCS9HS: ['ES'], A1VC38T7YXB528: ['JP'],
};
const countriesFor = (marketplaceId: string | null): readonly string[] => (marketplaceId === null ? null : MARKETPLACE_COUNTRIES[marketplaceId]) ?? ['US'];
const blankFields = (country: string): Fields => ({ name: '', addressLine1: '', addressLine2: '', addressLine3: '', city: '', districtOrCounty: '',
  stateOrRegion: '', postalCode: '', countryCode: country });

/** The typed values as a candidate recipient: blank optional fields are absent, not empty. */
function candidate(fields: Fields): Record<string, string> {
  return Object.fromEntries(CREATOR_MCF_RECIPIENT_FIELDS.flatMap((field) => fields[field].trim() === '' ? [] : [[field, fields[field]]]));
}

/** The block as a label prints it. */
function blockLines(recipient: CreatorMcfRecipient): string[] {
  const place = [recipient.city, [recipient.stateOrRegion, recipient.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [recipient.name, recipient.addressLine1, recipient.addressLine2, recipient.addressLine3, recipient.districtOrCounty, place, recipient.countryCode]
    .filter((line): line is string => line !== undefined && line !== '');
}

function LaneFacts({ detail, currency }: { detail: CreatorPreflightDetail; currency: string | null }) {
  const lane = detail.lane!;
  const preflight = detail.preflight;
  return <dl style={grid} data-testid="send-lane">
    <Row label="Tracker row" fact="record">{lane.creatorRecordId}{preflight?.trackerSourceRef ? ` · ${preflight.trackerSourceRef}` : ''}</Row>
    <Row label="Sends" fact="sends">1 × {lane.sku ?? 'SKU not recorded'} ({lane.asin})</Row>
    <Row label="Shipping" fact="shipping">Standard</Row>
    <Row label="Fee cap" fact="fee-cap">{minor(lane.feeCapCents, currency)}</Row>
  </dl>;
}

/** `posting`: the form is already empty and only the envelope is in flight; nothing typed is rendered. */
type Stage = 'closed' | 'entering' | 'review' | 'sealing' | 'posting';

function AddressEntry({ detail, binding, sendKey, marketplaceId, currency, actions, superseding, onSealed }: {
  detail: CreatorPreflightDetail; binding: CreatorMcfRecipientBinding; sendKey: Extract<SendKey, { status: 'ok' }>; marketplaceId: string | null;
  currency: string | null;
  actions: SendActions | undefined; superseding: boolean; onSealed: () => void;
}) {
  const countries = countriesFor(marketplaceId);
  const [mounted, setMounted] = useState(false);
  const [stage, setStage] = useState<Stage>(superseding ? 'closed' : 'entering');
  const [fields, setFields] = useState<Fields>(() => blankFields(countries[0]!));
  const [issues, setIssues] = useState<readonly CreatorMcfRecipientIssue[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => { setMounted(true); }, []);
  const lane = detail.lane!;
  const intro = <p style={{ margin: 0 }}>Copy the address from the tracker row for <strong>{lane.creatorRecordId}</strong>. The browser seals it to the MCF
    worker&apos;s key; Arcana stores and shows only the country, the first two postal characters and the number of lines.</p>;
  if (!mounted) {
    if (superseding) return null;
    return <Card title="Creator's address" testid="address-entry"><LaneFacts detail={detail} currency={currency} />
      <p className="wa-page-sub" data-testid="address-form-pending" style={{ margin: 0 }}>The address form appears once this page has loaded in the browser.</p></Card>;
  }
  if (!creatorMcfEnvelopeSupported()) {
    return <Card title="Creator's address" testid="address-entry"><LaneFacts detail={detail} currency={currency} />
      <p data-testid="browser-unsupported" style={{ margin: 0 }}>Sending needs a current browser: this one cannot seal an address, so nothing can be typed here.</p></Card>;
  }
  if (stage === 'closed') {
    return <p style={row} data-testid="address-again">
      <button type="button" className="wa-btn" data-testid="type-again" onClick={() => { setFailure(null); setStage('entering'); }}>Type the address again</button>
      <span className="wa-page-sub">A new address replaces the sealed one; the old one is withdrawn and destroyed.</span>
      {failure === null ? null : <span role="alert" data-testid="seal-refused">{failure}</span>}</p>;
  }
  const review = () => {
    const found = creatorMcfRecipientIssues(candidate(fields));
    setIssues(found);
    if (found.length === 0) setStage('review');
  };
  const seal = async () => {
    const parsed = CreatorMcfRecipient.safeParse(candidate(fields));
    if (!parsed.success) { setStage('entering'); return; }
    setStage('sealing');
    setFailure(null);
    let body: { binding: CreatorMcfRecipientBinding; envelope: Awaited<ReturnType<typeof sealCreatorMcfRecipient>> };
    const memory = { initials: initialsOf(parsed.data.name), postalCode: parsed.data.postalCode };
    try {
      body = { binding, envelope: await sealCreatorMcfRecipient(sendKey.jwk, sendKey.keyId, binding, parsed.data) };
    } catch {
      setFields(blankFields(countries[0]!));
      setStage('entering');
      setFailure('The address could not be sealed in this browser. Nothing was sent. Type it again.');
      return;
    }
    // The plaintext leaves React state, and the DOM, before anything is posted.
    flushSync(() => {
      setFields(blankFields(countries[0]!));
      setIssues([]);
      setStage('posting');
    });
    const result = actions === undefined ? { ok: false as const, reason: 'unavailable' as const } : await actions.seal(body).catch(() => ({ ok: false as const, reason: 'unavailable' as const }));
    if (result.ok) {
      sealedInTab.set(result.sendId, memory);
      setStage('closed');
      onSealed();
      return;
    }
    setStage('entering');
    setFailure(`${REFUSAL_WORDS[result.reason]} Nothing was stored; type the address again.`);
  };
  if (stage === 'posting') {
    return <Card title="Creator's address" testid="address-posting"><p style={{ margin: 0 }} data-testid="seal-posting">The address is sealed and the form
      is cleared. Storing the sealed envelope…</p></Card>;
  }
  const typed = stage === 'review' || stage === 'sealing' ? CreatorMcfRecipient.safeParse(candidate(fields)) : null;
  if (typed !== null && typed.success) {
    const recipient = typed.data;
    return <Card title="Check the address against the tracker row" testid="address-review">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(16rem, 1fr))', gap: '1rem' }}>
        <div data-testid="review-block" style={{ whiteSpace: 'pre-line', fontWeight: 600 }}>{blockLines(recipient).join('\n')}</div>
        <div data-testid="review-source" className="wa-stack" style={{ gap: '0.25rem' }}>
          <span>Tracker row <strong data-testid="review-record">{lane.creatorRecordId}</strong> · ASIN <code>{lane.asin}</code></span>
          {detail.preflight?.trackerSourceRef ? <span className="wa-page-sub">{detail.preflight.trackerSourceRef}</span> : null}
          <span className="wa-page-sub">Arcana does not check this address against the creator. This panel is the check: the block must come from this row.</span>
        </div>
      </div>
      <p style={row}>
        <button type="button" className="wa-btn wa-btn--primary" data-testid="seal-address" disabled={stage === 'sealing'} onClick={() => { void seal(); }}>
          {stage === 'sealing' ? 'Sealing…' : 'Seal address'}</button>
        <button type="button" className="wa-btn" data-testid="edit-address" disabled={stage === 'sealing'} onClick={() => setStage('entering')}>Edit</button>
      </p>
    </Card>;
  }
  const field = (name: CreatorMcfRecipientField) => {
    const id = `mcf-recipient-${name}`;
    const problems = issues.filter((issue) => issue.field === name);
    const common = {
      id, value: fields[name], autoComplete: 'off', spellCheck: false, 'data-1p-ignore': 'true', 'data-lpignore': 'true', 'data-form-type': 'other',
      'aria-invalid': problems.length > 0 ? true : undefined, 'data-recipient-field': name,
    } as const;
    const onChange = (value: string) => setFields((current) => ({ ...current, [name]: value }));
    return <div key={name} className="wa-stack" style={{ gap: '0.15rem' }}>
      <label htmlFor={id} className="wa-page-sub">{LABEL[name]}</label>
      {name === 'countryCode'
        ? <select className="wa-input" {...common} onChange={(event) => onChange(event.target.value)}>
          {countries.map((country) => <option key={country} value={country}>{country}</option>)}</select>
        : <input className="wa-input" type="text" maxLength={name === 'postalCode' ? 20 : 60} {...common} onChange={(event) => onChange(event.target.value)} />}
      {problems.map((issue) => <span key={issue.rule} className="wa-page-sub" data-testid="recipient-issue">{issueWords(issue)}</span>)}
    </div>;
  };
  const general = issues.filter((issue) => issue.field === null || issue.field === 'phone' || issue.field === 'email');
  return <Card title="Creator's address" testid="address-entry">
    <LaneFacts detail={detail} currency={currency} />
    {intro}
    <div data-testid="address-form" role="group" aria-label="Creator's address"
      style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))', gap: '0.5rem 1rem' }}>
      {CREATOR_MCF_RECIPIENT_FIELDS.map(field)}
    </div>
    {general.map((issue) => <p key={`${issue.field ?? ''}${issue.rule}`} data-testid="recipient-issue" style={{ margin: 0 }}>{issueWords(issue)}</p>)}
    {failure === null ? null : <p role="alert" data-testid="seal-refused" style={{ margin: 0 }}>{failure}</p>}
    <p style={row}>
      <button type="button" className="wa-btn wa-btn--primary" data-testid="review-address" onClick={review}>Review address</button>
      {superseding ? <button type="button" className="wa-btn" data-testid="cancel-entry" onClick={() => { setFields(blankFields(countries[0]!)); setIssues([]); setStage('closed'); }}>
        Keep the sealed address</button> : null}
      <span className="wa-page-sub">No phone or email: Amazon receives the address lines only.</span>
    </p>
  </Card>;
}

// ---------------------------------------------------------------------------
// The sealed card and Arcana's preview
// ---------------------------------------------------------------------------

function SealedCard({ send }: { send: CreatorMcfLaneSend }) {
  const memory = sealedInTab.get(send.sendId);
  return <section className="wa-card" data-testid="sealed-card"><div className="wa-card__body wa-stack" style={{ gap: '0.25rem' }}>
    <strong data-testid="sealed-mask">{send.mask === null ? 'Address sealed · destination purged'
      : `Address sealed · ${maskText(send.mask)}${send.custodyExpiresAt === null ? '' : ` · expires ${hhmm(send.custodyExpiresAt)}`}`}</strong>
    {memory === undefined ? null
      : <span className="wa-page-sub" data-testid="sealed-memory">In this tab only: {memory.initials} · {memory.postalCode}. Never stored or sent.</span>}
    <span className="wa-page-sub">There is no way to show the sealed address. To correct it, type it again.</span>
  </div></section>;
}

function Fees({ preview }: { preview: CreatorMcfSendPreview }) {
  if (preview.fees === null) return <>Amazon returned no fee estimate</>;
  const { fees } = preview;
  const cap = (value: number | null, label: string) => value === null ? `${label} cap not set` : `${fees.totalMinor <= value ? 'within' : 'over'} the ${minor(value, fees.currency)} ${label} cap`;
  return <><span data-testid="fee-parts">{fees.parts.map((part) => `${part.feeName} ${minor(part.amountMinor, fees.currency)}`).join(' + ')}</span>
    {' '}= <strong data-testid="fee-total">{minor(fees.totalMinor, fees.currency)}</strong>, {cap(preview.laneFeeCapMinor, 'lane')},
    {' '}{preview.grantCurrency !== null && preview.grantCurrency !== fees.currency ? `grant currency ${preview.grantCurrency}` : cap(preview.grantFeeCapMinor, 'grant')}</>;
}

/** Items as the per-SKU line reads: "1 × SKU (ASIN)". */
const itemLine = (preview: CreatorMcfSendPreview) => preview.items.map((item) => `${item.quantity} × ${item.sellerSku} (${preview.asin})`).join(', ');

function PreviewCard({ send, preview, previewAt, title = 'What this will do' }: {
  send: CreatorMcfLaneSend; preview: CreatorMcfSendPreview; previewAt: { readAt: string; validUntil: string }; title?: string;
}) {
  const window = preview.earliestArrivalDate === null && preview.latestArrivalDate === null ? 'not given'
    : `${preview.earliestArrivalDate ?? 'not given'} to ${preview.latestArrivalDate ?? 'not given'}`;
  return <Card title={title} testid="mcf-preview">
    <dl style={grid}>
      <Row label="Items" fact="items">{itemLine(preview)}, total {preview.totalUnits} {preview.totalUnits === 1 ? 'unit' : 'units'}</Row>
      <Row label="Shipping" fact="shipping">{preview.shippingSpeedCategory} shipping, {preview.fulfillmentAction}, {preview.fulfillmentPolicy}</Row>
      <Row label="Fee" fact="fee"><Fees preview={preview} /></Row>
      <Row label="Fulfillable" fact="fulfillable">{preview.isFulfillable ? 'yes'
        : `no: ${preview.unfulfillableReasons.length === 0 ? 'Amazon named no reason' : preview.unfulfillableReasons.map(codeWords).join(', ')}`}</Row>
      <Row label="Arrival window" fact="arrival">{window}</Row>
      <Row label="Destination" fact="destination">{send.mask === null ? 'destination purged' : maskText(send.mask)}</Row>
      <Row label="Order id" fact="order-id"><code>{preview.derivedOrderKey}</code></Row>
      <Row label="Pre-flight" fact="preflight">run {preview.preflightRunId} · completed {formatTimestamp(preview.preflightCompletedAt)}</Row>
      <Row label="Seller account and marketplace" fact="account">connection {preview.spapiConnectionId.slice(0, 8)}… · marketplace {preview.marketplaceId}</Row>
      <Row label="Read" fact="read">Amazon · getFulfillmentPreview · {formatTimestamp(previewAt.readAt)} · valid until {formatTimestamp(previewAt.validUntil)}</Row>
    </dl>
    <p style={{ margin: 0 }} data-testid="irreversibility">{CREATOR_MCF_IRREVERSIBILITY}</p>
  </Card>;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function useCommand(onDone: () => void) {
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'bad' | 'good'; text: string } | null>(null);
  const run = async (name: string, call: (() => Promise<SendActionResult>) | undefined, done?: string) => {
    setPending(name);
    setMessage(null);
    const result = call === undefined ? { ok: false as const, reason: 'unavailable' as SendActionFailure }
      : await call().catch(() => ({ ok: false as const, reason: 'unavailable' as SendActionFailure }));
    setPending(null);
    if (result.ok) {
      if (done !== undefined) setMessage({ tone: 'good', text: done });
    } else setMessage({ tone: 'bad', text: REFUSAL_WORDS[result.reason] });
    // A refusal can mean the page is out of date (an expired preview, a changed lane): read it again either way.
    onDone();
  };
  const note = message === null ? null
    : <p role={message.tone === 'bad' ? 'alert' : 'status'} data-testid={message.tone === 'bad' ? 'command-refused' : 'command-done'} style={{ margin: 0 }}>{message.text}</p>;
  return { pending, run, note };
}

function Withdraw({ send, actions, command }: { send: CreatorMcfLaneSend; actions: SendActions | undefined; command: ReturnType<typeof useCommand> }) {
  if (!WITHDRAWABLE.includes(send.state)) return null;
  return <button type="button" className="wa-btn" data-testid="withdraw" disabled={command.pending !== null}
    onClick={() => { void command.run('withdraw', actions && (() => actions.withdraw(send.sendId))); }}>Withdraw</button>;
}

// ---------------------------------------------------------------------------
// One send, by state
// ---------------------------------------------------------------------------

const STALE_ROWS: readonly (readonly [string, string, readonly string[], (preview: CreatorMcfSendPreview) => string])[] = [
  ['lane', 'Order id and reservation', ['derivedOrderKey', 'reservationId', 'sendId'], (p) => `${p.derivedOrderKey} · ${p.reservationId}`],
  ['items', 'ASIN, SKU and units', ['asin', 'items', 'totalUnits'], (p) => `${itemLine(p)}, total ${p.totalUnits}`],
  ['fulfillable', 'Fulfillable', ['isFulfillable', 'unfulfillableReasons'], (p) => p.isFulfillable ? 'yes' : 'no'],
  ['fee', 'Fee against the caps', ['fees', 'laneFeeCapMinor', 'grantFeeCapMinor', 'grantCurrency'],
    (p) => p.fees === null ? 'no estimate' : `${minor(p.fees.totalMinor, p.fees.currency)} of ${minor(p.laneFeeCapMinor, p.fees.currency)}`],
  ['arrival', 'Arrival window', ['earliestArrivalDate', 'latestArrivalDate'], (p) => `${p.earliestArrivalDate ?? 'not given'} to ${p.latestArrivalDate ?? 'not given'}`],
  ['order', 'No order under this id', ['existingOrder'], () => 'none'],
  ['settings', 'Shipping and policy', ['shippingSpeedCategory', 'fulfillmentAction', 'fulfillmentPolicy', 'featureConstraints'],
    (p) => `${p.shippingSpeedCategory}, ${p.fulfillmentAction}, ${p.fulfillmentPolicy}`],
  ['account', 'Seller account and marketplace', ['spapiConnectionId', 'marketplaceId'], (p) => `${p.spapiConnectionId.slice(0, 8)}… · ${p.marketplaceId}`],
  ['preflight', 'Pre-flight', ['preflightRunId', 'preflightCompletedAt'], (p) => p.preflightRunId],
  ['sealed', 'Sealed address', ['envelopeSha256', 'keyId'], () => 'the same envelope'],
];

/** The ledger's unsendable codes that name a row rather than a preview field; grant_inactive names none, so rows stay "not recorded". */
const CODE_ROW_FIELD: Record<string, string> = {
  fee_over_lane_cap: 'fees', fee_over_grant_cap: 'fees', lane_cap_missing: 'fees', currency_mismatch: 'fees', fee_missing: 'fees',
  not_fulfillable: 'isFulfillable',
};

/** 449:221: what was approved, and which values no longer agree. Without recorded codes a row says so, never "agrees". */
function StaleView({ send, preview, detail }: { send: CreatorMcfLaneSend; preview: CreatorMcfSendPreview | null; detail: CreatorPreflightDetail }) {
  const event = arrivalEvent(send);
  const codes = event?.codes ?? [];
  const changed = new Set(codes.flatMap((code) => code === 'grant_inactive' ? [] : [CODE_ROW_FIELD[code] ?? code]));
  const caps = send.stateReason === 'caps_changed';
  const known = changed.size > 0;
  return <>
    <section className="wa-banner wa-banner--bad" data-testid="stale-banner" data-reason={send.stateReason ?? 'none'} style={{ display: 'block' }}>
      <strong>The order behind this preview changed between reading it and sending, so nothing was sent.</strong>{' '}
      {caps ? 'Just before the order request, the fee no longer fits the caps as they stand now.'
        : `The worker re-read Amazon just before the order request${event === null ? '' : ` at ${formatTimestamp(event.at)}`}.`}
      {' '}{known ? `${changed.size} ${changed.size === 1 ? 'value' : 'values'} no longer ${changed.size === 1 ? 'matches' : 'match'}.`
        : 'The ledger recorded no value names for the difference.'}
      {' '}A preview that no longer describes the order is not an approval.
    </section>
    {preview === null ? null : <TableFrame><table className="wa-table" data-testid="stale-compare">
      <thead><tr><th>What was approved</th><th>At {formatTimestamp(preview.readAt)}</th><th>Still agrees?</th></tr></thead>
      <tbody>{STALE_ROWS.map(([key, label, fields, value]) => {
        const differs = fields.some((field) => changed.has(field));
        const verdict = !known ? 'unknown' : differs ? 'changed' : 'agrees';
        return <tr key={key} data-testid="stale-row" data-row={key} data-agrees={verdict === 'unknown' ? 'unknown' : differs ? 'false' : 'true'}>
          <td>{label}</td><td>{value(preview)}</td>
          <td><Badge tone={verdict === 'changed' ? 'bad' : verdict === 'agrees' ? 'good' : 'neutral'}>{verdict === 'unknown' ? 'not recorded' : verdict}</Badge></td>
        </tr>;
      })}</tbody>
    </table></TableFrame>}
    <p className="wa-page-sub" style={{ margin: 0 }}>The ledger keeps which values changed, not the re-read values themselves.</p>
    <div className="wa-grid-2">
      <Card title="Nothing was ordered" testid="stale-nothing-ordered"><p style={{ margin: 0 }}>No order request reached Amazon, no unit was committed and the
        lane did not move. The sealed address is still held until {send.custodyExpiresAt === null ? 'it expires' : hhmm(send.custodyExpiresAt)}.</p></Card>
      <Card title="A stale preview needs a new approval" testid="stale-new-approval"><p style={{ margin: 0 }}>Preview again for a fresh read and a
        new press, or withdraw. The old approval is never carried forward.{detail.lane === null ? '' : ' A different product is a product switch.'}</p></Card>
    </div>
  </>;
}

/** 447:2: the POST outcome is unknown, and one read of the order id answers whether an order exists. */
function UncertainView({ send, view }: { send: CreatorMcfLaneSend; view: CreatorMcfLaneView }) {
  const settlement = view.lane.settlement;
  const escalated = settlement?.settlement === 'escalated';
  const exists = settlement === null ? 'ask Amazon' : settlement.settlement === 'found' ? 'found' : `not found on ${settlement.notFoundProbes} ${settlement.notFoundProbes === 1 ? 'read' : 'reads'}`;
  return <>
    <section className={`wa-banner ${escalated ? 'wa-banner--bad' : 'wa-banner--warn'}`} data-testid="uncertain-banner" data-escalated={escalated ? 'true' : 'false'} style={{ display: 'block' }}>
      <strong>{escalated ? 'Escalated: Amazon has answered not found three times, and a person looks.' : 'The order request returned nothing Arcana can read as success or failure.'}</strong>{' '}
      Whether the request was sent, whether Amazon accepted it, and whether an order exists are separate questions. Asking Amazon for this order id answers the
      third. The lane stays in Reconciliation Required, and no second order is ever requested.
    </section>
    <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))' }} data-testid="uncertain-questions">
      <Card title="Was the request sent?" testid="uncertain-sent"><Badge tone="good">{send.intentReservedAt === null ? 'reserved, time not recorded' : `reserved at ${hhmm(send.intentReservedAt)}`}</Badge></Card>
      <Card title="Did Amazon accept it?" testid="uncertain-accepted"><Badge tone="warn">not known</Badge>
        <span className="wa-page-sub">{send.providerReason === null ? 'No cause recorded.' : `Cause: ${send.providerReason}${send.providerStatus === null ? '' : `, HTTP ${send.providerStatus}`}.`}</span></Card>
      <Card title="Does an order exist?" testid="uncertain-exists"><Badge tone={settlement?.settlement === 'found' ? 'good' : 'info'}>{exists}</Badge>
        {settlement === null ? null : <span className="wa-page-sub">last read {formatTimestamp(settlement.lastProbeAt)}</span>}</Card>
    </div>
    <p className="wa-page-sub" style={{ margin: 0 }} data-testid="release-rule">Release as not created is allowed only after three not-found reads made after the
      reservation, over at least 30 minutes, including one complete order list read, and no read that found it. A timeout or a missing answer is never
      a reason on its own.</p>
  </>;
}

function Outcome({ send, view }: { send: CreatorMcfLaneSend; view: CreatorMcfLaneView }) {
  const event = arrivalEvent(send);
  const codes = send.providerCodes ?? event?.codes ?? [];
  const reason = send.stateReason === null ? null : STATE_REASON_WORDS[send.stateReason] ?? send.stateReason;
  const key = view.lane.derivedOrderKey;
  switch (send.state) {
    case 'approved':
      return <p style={{ margin: 0 }} data-testid="approved-note">Approved at {send.approvedAt === null ? 'a time not recorded' : formatTimestamp(send.approvedAt)} for
        {' '}{send.units ?? 'an unrecorded number of'} {send.units === 1 ? 'unit' : 'units'}. The worker re-reads the preview, then asks Amazon; if it has not claimed
        the approval by {send.claimDeadline === null ? 'its deadline' : hhmm(send.claimDeadline)} the approval expires and nothing is sent.</p>;
    case 'dispatching':
      return <p style={{ margin: 0 }} data-testid="dispatching-note">The worker reserved the order request at {send.intentReservedAt === null ? 'a time not recorded'
        : formatTimestamp(send.intentReservedAt)} and is sending it now. It cannot be withdrawn.</p>;
    case 'accepted':
      return <p style={{ margin: 0 }} data-testid="accepted-note">Amazon answered HTTP 200 at {send.acceptedAt === null ? 'a time not recorded'
        : formatTimestamp(send.acceptedAt)}. Awaiting validation: the lane reads Placed once a read shows Received or later with this SKU and one unit.</p>;
    case 'placed':
      return <p style={{ margin: 0 }} data-testid="placed-note">Amazon holds the order{send.amazonStatus === null ? '' : ` (${send.amazonStatus})`}, read
        {' '}{send.placedAt === null ? '' : `at ${formatTimestamp(send.placedAt)} `}with this SKU and one unit. <a href={`/creators/samples/fulfillment/${key}`}
        data-testid="placed-link">Shipments and carrier scans</a></p>;
    case 'rejected':
      return <p style={{ margin: 0 }} data-testid="rejected-note">Rejected: {codes.length === 0 ? 'no code' : codes.map((code) => <code key={code}>{code}</code>)}
        {send.providerStatus === null ? '' : ` (HTTP ${send.providerStatus}${send.providerReason === null ? '' : `, ${send.providerReason}`})`}.
        {' '}A follow-up read under this id found no order, so nothing was placed.</p>;
    case 'uncertain': return <UncertainView send={send} view={view} />;
    case 'conflict':
      return <section className="wa-banner wa-banner--bad" data-testid="conflict-banner" style={{ display: 'block' }}>
        <strong>Amazon has an order under this id that does not match this send.</strong>{' '}
        {codes.length === 0 ? 'No mismatch code was recorded.' : <>Mismatch: {codes.map((code) => <code key={code}>{code} </code>)}.</>}
        {' '}Amazon status {send.amazonStatus ?? view.lane.mcfStatus ?? 'not read'}. Record it as sent only after checking it in Amazon; cancel only while Received or Planning.
      </section>;
    case 'not_created':
      return <p style={{ margin: 0 }} data-testid="not-created-note">{reason ?? 'Released as not created.'} The lane is back with the runner as Reserved.</p>;
    case 'failed_by_amazon':
      return <p style={{ margin: 0 }} data-testid="failed-note">Amazon holds the order as {send.amazonStatus ?? 'a failed status'}; the lane is Cancelled. The runner
        clears its lock with cancel-mcf.</p>;
    case 'failed_after_placement':
      return <p style={{ margin: 0 }} data-testid="failed-after-note">The placed order later became {send.amazonStatus ?? 'Cancelled or Unfulfillable'} in Amazon; the
        lane is Cancelled.</p>;
    case 'preview_refused':
      return <p style={{ margin: 0 }} data-testid="refused-note">{reason ?? 'The preview was refused.'}{codes.length === 0 ? ''
        : ` ${codes.map(codeWords).join('; ')}.`} The sealed address was destroyed; nothing was ordered.</p>;
    case 'withdrawn': case 'expired': case 'expired_unclaimed':
      return <p style={{ margin: 0 }} data-testid="ended-note">{reason ?? SEND_STATE_WORDS[send.state].title}. The sealed address was destroyed; nothing was ordered.</p>;
    case 'cancel_requested': case 'cancel_dispatching': case 'cancelled':
      return <CancelProgress send={send} view={view} />;
    default:
      return null;
  }
}

function SendCard({ send, view, detail, data, sendingOn, actions, now, onChange }: {
  send: CreatorMcfLaneSend; view: CreatorMcfLaneView; detail: CreatorPreflightDetail; data: SendData; sendingOn: boolean; actions: SendActions | undefined;
  now: string; onChange: () => void;
}) {
  const command = useCommand(onChange);
  /** One request id per preview: a double press replays, and a press on a fresh preview after a stale one is a new request. */
  const approveRequest = useRef<{ previewId: string; id: string } | null>(null);
  const resolveRequest = useRef<string | null>(null);
  const words = SEND_STATE_WORDS[send.state];
  const latest = send.latestPreview;
  const preview = latest !== null && latest.preview.kind !== 'cancel_preview' ? latest.preview : null;
  const escalatedLadder = send.escalationReason === 'ladder_exhausted';
  const act = data.canAct;
  const settleable = ['accepted', 'uncertain', 'conflict', 'cancel_dispatching'].includes(send.state);
  const heldCustody = SUPERSEDABLE.includes(send.state) || send.state === 'approved';
  const current = preview !== null && latest !== null && previewCurrent(latest, now);

  const sendButton = (() => {
    if (send.state !== 'preview_ready' || preview === null || latest === null || !act) return null;
    if (!sendingOn) return null;
    if (!current) {
      return <p className="wa-page-sub" data-testid="preview-old" style={{ margin: 0 }}>This preview is older than 30 minutes or past its validity, so it cannot be
        sent. Preview again.</p>;
    }
    const confirmation = creatorMcfSendConfirmation(preview.totalUnits);
    const press = () => {
      if (approveRequest.current?.previewId !== latest.previewId) approveRequest.current = { previewId: latest.previewId, id: globalThis.crypto.randomUUID() };
      const approval = { sendId: send.sendId, previewId: latest.previewId, previewFingerprint: latest.fingerprint, totalUnits: preview.totalUnits,
        confirmation, requestId: approveRequest.current.id };
      void command.run('approve', actions && (() => actions.approve(approval)));
    };
    return <div className="wa-stack" style={{ gap: '0.35rem' }} data-testid="send-confirmation">
      <span data-testid="sku-line">{itemLine(preview)}</span>
      <p style={row}>
        <button type="button" className="wa-btn wa-btn--primary" data-testid="send-button" disabled={command.pending !== null} onClick={press}>{confirmation}</button>
        <Withdraw send={send} actions={actions} command={command} />
      </p>
    </div>;
  })();

  return <section className="wa-stack" data-testid="send-card" data-send-state={send.state} data-escalation={send.escalationReason ?? 'none'}>
    <p style={{ ...row, margin: 0 }}><Badge tone={words.tone}>{words.title}</Badge>
      <span className="wa-page-sub">{send.state === 'preview_refused' || send.state === 'rejected' ? 'Nothing was placed.' : ''} Since {formatTimestamp(send.stateChangedAt)}</span></p>
    {heldCustody ? <SealedCard send={send} /> : null}
    {escalatedLadder ? <section className="wa-banner wa-banner--bad" data-testid="ladder-exhausted" style={{ display: 'block' }}>
      <strong>Amazon has not settled this order in 7 days.</strong>{' '}The worker&apos;s scheduled reads are exhausted. Ask Amazon for this order id, and check it in
      Seller Central before anything else.</section> : null}
    {send.state === 'stale' ? <StaleView send={send} preview={preview} detail={detail} /> : null}
    {send.state === 'preview_ready' && preview !== null && latest !== null ? <PreviewCard send={send} preview={preview} previewAt={latest} /> : null}
    {send.state === 'sealed' || send.state === 'previewing' ? <p className="wa-page-sub" data-testid="previewing-note" style={{ margin: 0 }}>
      {send.state === 'sealed' ? 'Waiting for the MCF worker to open the address and ask Amazon for a preview.'
        : 'The MCF worker is asking Amazon: first whether an order already exists under this id, then for a preview of exactly this order.'} This page refreshes on its own.</p> : null}
    <Outcome send={send} view={view} />
    {sendButton}
    {act ? <p style={row} data-testid="send-controls">
      {send.state === 'preview_ready' && (!sendingOn || !current) ? <Withdraw send={send} actions={actions} command={command} /> : null}
      {send.state !== 'preview_ready' ? <Withdraw send={send} actions={actions} command={command} /> : null}
      {(send.state === 'stale' || (send.state === 'preview_ready' && !current)) ? <button type="button" className="wa-btn" data-testid="preview-again"
        disabled={command.pending !== null} onClick={() => { void command.run('refresh', actions && (() => actions.refresh(send.sendId))); }}>Preview again</button> : null}
      {send.state === 'stale' && detail.lane !== null ? <a className="wa-btn" href={`/creators/samples/${detail.lane.derivedOrderKey}/product-switch`}
        data-testid="stale-product-switch">Open the product switch</a> : null}
      {settleable ? <button type="button" className="wa-btn" data-testid="ask-amazon" disabled={command.pending !== null}
        onClick={() => { void command.run('settle', actions && (() => actions.settleRead(send.sendId)), 'Amazon will be asked for this order id on the worker\'s next pass.'); }}>
        Ask Amazon for this order id</button> : null}
      {send.state === 'uncertain' ? <>
        <button type="button" className="wa-btn" data-testid="release" disabled={command.pending !== null}
          onClick={() => { void command.run('release', actions && (() => actions.release(send.sendId))); }}>Release as not created</button>
        <button type="button" className="wa-btn wa-btn--primary" data-testid="leave-locked" disabled={command.pending !== null}
          onClick={() => { void command.run('leave', async () => ({ ok: true, sendId: send.sendId, state: send.state }), 'Nothing changed. The lane stays locked.'); }}>
          Leave locked</button></> : null}
      {send.state === 'conflict' ? <>
        <button type="button" className="wa-btn wa-btn--primary" data-testid="record-as-sent" disabled={command.pending !== null}
          onClick={() => { resolveRequest.current ??= globalThis.crypto.randomUUID(); const request = resolveRequest.current;
            void command.run('resolve', actions && (() => actions.resolveConflict(send.sendId, request))); }}>Record as sent</button>
      </> : null}
    </p> : null}
    <CancelControls send={send} view={view} data={data} now={now} command={command}
      actions={actions?.requestCancelPreview === undefined || actions.approveCancel === undefined ? undefined
        : { requestCancelPreview: actions.requestCancelPreview, approveCancel: actions.approveCancel }} />
    {command.note}
  </section>;
}

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

const BLOCK_WORDS: Record<LaneBlock['kind'], (block: LaneBlock) => string> = {
  no_lane: () => 'No sample lane carries this key, so there is nothing to send.',
  not_reserved: (block) => `The lane is ${(block as Extract<LaneBlock, { kind: 'not_reserved' }>).laneState}, not Reserved: the runner has not handed it over, so it cannot take an address.`,
  arcana_owned: () => 'Arcana already owns this lane\'s order.',
  reservation_form: () => 'The lane\'s reservation id is not in the form reserve_mcf issues, so an address cannot be bound to it.',
  no_sku: () => 'The lane records no SKU, so there is nothing to send.',
  record_conflict: () => 'The creator record is locked in Conflict. Nothing can be sent until it is resolved.',
  preflight_missing: () => 'No pre-flight is recorded for this lane. The runner runs it before any send.',
  preflight_hold: () => 'The newest pre-flight holds this lane, so it cannot take an address.',
  preflight_old: (block) => `The pre-flight completed ${formatTimestamp((block as Extract<LaneBlock, { kind: 'preflight_old' }>).completedAt)}, more than 24 hours ago. The runner must run it again before a send.`,
};

export function SendSection({ detail, now, data, actions }: { detail: CreatorPreflightDetail; now: string; data: SendData; actions?: SendActions }) {
  const router = useRouter();
  const [, setTick] = useState(0);
  const missing = sendingMissing(data.gate, data.key);
  const sendingOn = missing.length === 0;
  const view = data.mcf;
  const send = view?.send ?? null;
  const refresh = () => { setTick((value) => value + 1); router.refresh(); };
  const phase = send !== null && ['placed', 'conflict'].includes(send.state) ? cancelPhase(send, now) : null;
  /** A current cancel preview re-reads the clock and the gate, so the button hides once it is too old; a stale one waits for a press. */
  const cancelReady = phase?.kind === 'preview' && phase.current;
  const every = send === null ? null : WAITING.includes(send.state) || cancelWaiting(send) ? REFRESH_MS
    : send.state === 'preview_ready' || cancelReady ? READY_REFRESH_MS : null;
  /** The page's actions, with the real cancel server actions when the page passed none. */
  const wired: SendActions | undefined = actions === undefined ? undefined : {
    ...actions, requestCancelPreview: actions.requestCancelPreview ?? requestMcfCancelPreview, approveCancel: actions.approveCancel ?? approveMcfCancel,
  };
  useEffect(() => {
    if (every === null) return;
    const timer = setInterval(() => { router.refresh(); }, every);
    return () => clearInterval(timer);
  }, [every, router]);

  const block = laneBlock(detail, now);
  const binding = sealBinding(detail, data.orgId);
  const canEnter = data.canAct && sendingOn && block === null && binding !== null && data.key.status === 'ok' && mayTakeAddress(send);
  const state = send?.state ?? (block !== null ? 'blocked' : !sendingOn ? 'sending-off' : data.canAct ? 'entering' : 'no-send');
  return <section className="wa-stack" data-testid="mcf-send" data-section-state={state} aria-label="Send through Amazon">
    <h2 className="wa-card__title" style={{ margin: 0 }}>Send through Amazon</h2>
    <SendingStatus missing={missing} data={data} />
    {data.gate?.unitsToday != null && data.gate.maxUnitsPerDay !== null
      ? <p className="wa-page-sub" data-testid="units-today" style={{ margin: 0 }}>Units approved today (UTC): {data.gate.unitsToday} of {data.gate.maxUnitsPerDay}.</p> : null}
    {send === null && block !== null ? <p data-testid="lane-block" data-block={block.kind} style={{ margin: 0 }}>{BLOCK_WORDS[block.kind](block)}</p> : null}
    {send === null && block === null && !data.canAct ? <p className="wa-page-sub" data-testid="no-send" style={{ margin: 0 }}>Nothing has been sealed for this lane.
      Owners and admins type the address here.</p> : null}
    {send !== null && view !== null
      ? <SendCard key={send.sendId} send={send} view={view} detail={detail} data={data} sendingOn={sendingOn} actions={wired} now={now} onChange={refresh} /> : null}
    {canEnter && data.key.status === 'ok' && binding !== null
      ? <AddressEntry key={`entry-${send?.sendId ?? 'new'}`} detail={detail} binding={binding} sendKey={data.key} marketplaceId={data.gate?.marketplaceId ?? null}
        currency={data.gate?.currency ?? null} actions={actions} superseding={send !== null && SUPERSEDABLE.includes(send.state)} onSealed={refresh} /> : null}
    {!data.canAct ? <p className="wa-page-sub" data-testid="analyst-note" style={{ margin: 0 }}>Owners and admins seal, send, withdraw, settle and cancel; this view has no
      controls.</p> : null}
  </section>;
}
