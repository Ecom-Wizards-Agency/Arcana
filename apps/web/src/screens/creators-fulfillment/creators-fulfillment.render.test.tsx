// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { CreatorMcfSendState } from '@wizard-ads/shared';
import type { CreatorMcfLaneSend } from '@wizard-ads/db';
import { NOT_SENT, OPEN_CANCEL, SEND } from '../creators-sample-preflight/render-fixture';
import { formatTimestamp } from '../../ui/date-format';
import Loading from '../../../app/creators/samples/fulfillment/[id]/loading';
import SharedError from '../../../app/creators/samples/fulfillment/[id]/error';
import { rendered } from '../render-test-support';
import { verifyScreen } from '../settings/render-support';
import { descriptor } from './descriptor';
import {
  ambiguous, empty, escalated, inTransit, missing, notFound, notMeasured, pendingShipment, processing, refused, trackingNotSafe,
} from './render-fixture';
import Screen, { probeCount } from './view';

verifyScreen(descriptor, [
  { state: 'loading', name: 'renders the route loading boundary', render: () => <Loading />, text: '' },
  { state: 'error', name: 'renders the shared error boundary with its reference', render: () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-reference' })} reset={() => { }} />, text: 'synthetic-reference' },
  { state: 'error', name: 'preserves the safe read error message', render: () => <Screen data={{ view: 'error', props: { message: 'Synthetic read unavailable' } }} />, text: 'Synthetic read unavailable' },
  { state: 'ready', name: 'asks three questions of an ambiguous submit and answers the third from the reads (447:2)', render: () => <Screen data={notFound} />, text: 'Amazon had no order under this id on 2 of 3 reads' },
  { state: 'ready', name: 'says a tracking number is not safe to send before the carrier moves it (449:2)', render: () => <Screen data={trackingNotSafe} />, text: 'There is a tracking number, and it is not safe to send yet.' },
  { state: 'refused', name: 'withholds the lane and what Amazon reported when the last read failed', render: () => <Screen data={refused} />, text: 'Nothing was read',
    absent: ['[data-testid="reconciliation"]', '[data-testid="fulfillment"]', '[data-testid="reservation-holds"]', '[data-testid="reads"]'] },
  { state: 'empty', name: 'says no lane carries a well-formed key', render: () => <Screen data={empty} />, text: 'No sample lane carries this key', absent: ['[data-testid="reads"]'] },
  { state: 'empty', name: 'says a malformed address names no sample order', render: () => <Screen data={missing} />, text: 'This address does not name a sample order key.' },
  { state: 'not-measured', name: 'says Amazon has not been asked, rather than that no order exists', render: () => <Screen data={notMeasured} />, text: 'not read yet',
    absent: ['[data-testid="observation"]', '[data-answer="not-found"]'] },
  { state: 'gated', name: 'keeps viewers out', render: () => <Screen data={{ view: 'gated', props: {} }} />, text: 'Owners, admins and analysts only' },
]);

const texts = (host: HTMLElement, selector: string) => [...host.querySelectorAll(selector)].map((item) => item.textContent);
const answers = (host: HTMLElement, selector: string) => [...host.querySelectorAll(selector)].map((item) => item.getAttribute('data-answer'));
const answer = (host: HTMLElement, question: string) => host.querySelector(`[data-question="${question}"]`)!;

describe('sample order: an ambiguous submit', () => {
  it('draws the header, the three questions unanswered, and says Amazon has not been asked', () => {
    const host = rendered(<Screen data={notMeasured} />);
    expect(host.querySelector('[data-status="run-by-hand"]')?.textContent).toBe('Run by hand');
    expect(host.querySelector('h1')?.textContent).toContain('Sample order');
    expect(host.textContent).toContain('CCR-SW-26-0072 · B0D9K3M2QP · MCFR-9f2c41ab77e0d3b5 · Reconciliation Required · Last read');
    expect(host.querySelector('[data-testid="order-key"]')?.textContent).toBe(ambiguous.derivedOrderKey);
    expect(host.querySelector('[data-lock="Locked for MCF"]')?.textContent).toBe('Locked for MCF');
    expect(host.querySelector('[data-testid="ambiguous-banner"]')?.textContent).toContain('one read answers the third');
    const questions = [...host.querySelectorAll('[data-testid="question"]')];
    expect(questions).toHaveLength(3);
    expect(questions.map((item) => item.getAttribute('data-question'))).toEqual(['submitted', 'accepted', 'exists']);
    expect(answers(host, '[data-testid="question"]')).toEqual(['yes', 'not-read', 'not-read']);
    expect(answer(host, 'submitted').textContent).toContain('yes, verified for submit at 06:44:12');
    expect(answer(host, 'submitted').textContent).toContain('outcome_unknown: the submit returned nothing the runner could read as success or failure.');
    expect(answer(host, 'exists').textContent).toContain('Amazon has not been asked about this order id.');
    expect(host.querySelector('[data-testid="settlement-line"]')?.getAttribute('data-settlement')).toBe('not-read');
    expect(host.querySelector('[data-testid="settlement-line"]')?.textContent).toBe('Settlement: not read yet. Amazon has not been asked about this order id.');
    expect(host.querySelector('[data-testid="no-observations"]')?.textContent).toBe('Amazon has not been asked about this order yet.');
    expect(host.querySelectorAll('[data-testid="observation"]')).toHaveLength(0);
    expect(host.querySelector('[data-testid="fulfillment"]')).toBeNull();
    expect(host.querySelector('[data-testid="record-link"], a[href="/creators/records/CCR-SW-26-0072"]')).not.toBeNull();
  });

  it('shows what the reservation holds, with the derived id and no invented quantity', () => {
    const host = rendered(<Screen data={notMeasured} />);
    const facts = [...host.querySelectorAll('[data-testid="reservation-facts"] [data-fact]')];
    expect(facts).toHaveLength(6);
    expect(facts.map((item) => item.getAttribute('data-fact'))).toEqual(['reservation', 'order-key', 'record', 'asin-sku', 'fee', 'lane-state']);
    expect(texts(host, '[data-testid="reservation-facts"] [data-fact]')).toEqual([
      'MCFR-9f2c41ab77e0d3b5', ambiguous.derivedOrderKey, 'CCR-SW-26-0072 · locked for MCF', 'B0D9K3M2QP · SW-DERMA-05-FBA', '6.20 · cap 8.00',
      'Reconciliation Required']);
    expect(host.textContent).not.toMatch(/quantity/i);
    const outcomes = host.querySelectorAll('[data-testid="three-outcomes"] [data-outcome]');
    expect(outcomes).toHaveLength(3);
    expect(host.querySelector('[data-outcome="not_found"]')?.textContent).toContain('the id is derived from the creator record and the ASIN rather than generated');
    expect(host.querySelector('[data-outcome="escalated"]')?.textContent).toContain('Still nothing after 3 reads running');
    expect(host.querySelector('[data-testid="no-new-order-id"]')?.textContent).toContain('A corrective second order is never placed');
    expect(host.querySelector('[data-testid="no-new-order-id"]')?.textContent).toContain('rejected by Amazon rather than shipped');
    expect(host.querySelector('[data-testid="lock-line"]')?.textContent).toContain('settling whether an order exists is not releasing the lock');
  });

  it('answers the third question from two not-found reads and lists them newest first', () => {
    const host = rendered(<Screen data={notFound} />);
    expect(answers(host, '[data-testid="question"]')).toEqual(['yes', 'not-known', 'not-found']);
    expect(host.querySelector('[data-testid="not-found-probes"]')?.textContent).toBe('2 of 3');
    expect(answer(host, 'exists').textContent).toContain('Amazon had no order under this id on 2 of 3 reads · last Amazon · getFulfillmentOrder · 08:44:31');
    const rows = [...host.querySelectorAll('[data-testid="observation"]')];
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.getAttribute('data-outcome'))).toEqual(['not_found', 'not_found']);
    expect(rows[0]!.textContent).toContain('08:44 UTC');
    expect(rows[0]!.textContent).toContain(`getFulfillmentOrder${ambiguous.derivedOrderKey}not found`);
    expect(host.querySelector('[data-testid="observation-count"]')?.textContent).toBe('2 of 2');
    expect(host.querySelector('[data-testid="settlement-line"]')?.textContent).toMatch(/^Settlement: not found on 2 of 3 reads running, last read 8 Sept? 2026 08:44 UTC\.$/);
    expect(host.querySelector('[data-testid="reads"]')?.textContent).toContain('The worker made these reads, with nobody in a browser. No read changes the lane state or releases the lock.');
    // A not-found read from the order list is attributed to that operation, not to getFulfillmentOrder.
    const listed = { ...notFound.props.detail, observations: notFound.props.detail.observations.map((item, index) => index === 0
      ? { ...item, operation: 'listAllFulfillmentOrders' as const } : item) };
    const listedHost = rendered(<Screen data={{ view: 'ready', props: { detail: listed } }} />);
    expect(answer(listedHost, 'exists').textContent).toContain('last Amazon · listAllFulfillmentOrders · 08:44:31');
    expect(answer(listedHost, 'exists').textContent?.match(/getFulfillmentOrder/g) ?? []).toHaveLength(0);
  });

  it('escalates after three reads found nothing and keeps the lane locked', () => {
    const host = rendered(<Screen data={escalated} />);
    expect(answers(host, '[data-testid="question"]')).toEqual(['yes', 'not-known', 'escalated']);
    expect(answer(host, 'exists').textContent).toContain('3 reads found nothing: stays locked, a person looks.');
    expect(host.querySelector('[data-testid="settlement-line"]')?.getAttribute('data-settlement')).toBe('escalated');
    expect(host.querySelectorAll('[data-testid="observation"]')).toHaveLength(3);
    expect(host.querySelector('[data-lock="Locked for MCF"]')).not.toBeNull();
  });

  it('answers all three once an order is found under the ambiguous id, and draws the stages too', () => {
    const lane = { ...ambiguous, mcf: processing.mcf, packages: processing.packages };
    const host = rendered(<Screen data={{ view: 'ready', props: { detail: { ...trackingNotSafe.props.detail, derivedOrderKey: ambiguous.derivedOrderKey, lane } } }} />);
    expect(answers(host, '[data-testid="question"]')).toEqual(['yes', 'yes', 'yes']);
    expect(answer(host, 'accepted').textContent).toContain('yes: Processing');
    expect(answer(host, 'accepted').textContent).toContain('Amazon · getFulfillmentOrder · 07:02:18');
    expect(host.querySelectorAll('[data-testid="stage"]')).toHaveLength(4);
    const cancelled = rendered(<Screen data={{ view: 'ready', props: { detail: { ...trackingNotSafe.props.detail, lane: { ...lane, mcf: { ...processing.mcf!, status: 'Cancelled' } } } } }} />);
    expect(answers(cancelled, '[data-testid="question"]')).toEqual(['yes', 'refused', 'yes']);
    expect(cancelled.querySelector('[data-stage="accepted"]')?.getAttribute('data-answer')).toBe('refused');
    expect(cancelled.querySelector('[data-stage="accepted"] .wa-badge')?.textContent).toBe('cancelled');
  });
});

describe('sample order: Amazon has the package', () => {
  it('draws four stages with shipment created as where it is now, and says it is not safe to send (449:2)', () => {
    const host = rendered(<Screen data={trackingNotSafe} />);
    expect(host.querySelector('[data-testid="reconciliation"]')).toBeNull();
    expect(host.querySelector('[data-testid="reservation-holds"]')).toBeNull();
    const banner = host.querySelector('[data-testid="not-safe-to-send"]')!;
    expect(banner.textContent).toContain('Carrier and tracking number can still change while a shipment is processing');
    expect(banner.textContent).toContain('The creator hears from us at in-transit, not before.');
    const stages = [...host.querySelectorAll('[data-testid="stage"]')];
    expect(stages).toHaveLength(4);
    expect(stages.map((stage) => stage.getAttribute('data-stage'))).toEqual(['accepted', 'shipment', 'in_transit', 'delivered']);
    expect(answers(host, '[data-testid="stage"]')).toEqual(['done', 'now', 'not_yet', 'not_yet']);
    expect(texts(host, '[data-testid="stage"] .wa-badge')).toEqual(['done', 'where it is now', 'not yet', 'not yet']);
    expect(host.querySelector('[data-stage="in_transit"]')?.textContent).toContain('the creator hears from us here');
    const facts = texts(host, '[data-testid="amazon-facts"] [data-fact]');
    expect(facts).toEqual(['Processing Amazon · getFulfillmentOrder · 07:02:18', '1']);
    const shipments = [...host.querySelectorAll('[data-testid="amazon-shipment"]')];
    expect(shipments).toHaveLength(1);
    expect(shipments[0]!.textContent).toContain('SYNTHETIC-SHIP-0088-A');
    expect(shipments[0]!.querySelectorAll('[data-value="not-read"]')).toHaveLength(1);
    const packages = [...host.querySelectorAll('[data-testid="amazon-package"]')];
    expect(packages).toHaveLength(1);
    expect(packages[0]!.textContent).toContain('Synthetic carrier');
    expect(packages[0]!.textContent).toContain('SYNTHETIC-TRACK-0088');
    expect(packages[0]!.querySelector('[data-value="no-carrier-status"]')?.textContent).toBe('no carrier status yet');
    expect(host.querySelector('[data-testid="split-shipments"]')).toBeNull();
    expect(host.querySelector('[data-testid="whole-array"]')?.textContent).toContain('A cancelled shipment can be replaced by another entry in the same array');
    expect(host.querySelector('[data-testid="settlement-line"]')?.getAttribute('data-settlement')).toBe('found');
    expect(host.querySelectorAll('[data-testid="observation"]')).toHaveLength(1);
    expect(host.querySelector('[data-testid="observation"]')?.textContent).toContain('found · Processing');
  });

  it('moves to in transit once the carrier scans it, with the tracking read time, and counts the reads shown of those kept', () => {
    const host = rendered(<Screen data={inTransit} />);
    expect(host.querySelector('[data-testid="not-safe-to-send"]')).toBeNull();
    expect(answers(host, '[data-testid="stage"]')).toEqual(['done', 'done', 'now', 'not_yet']);
    const item = host.querySelector('[data-testid="amazon-package"]')!;
    expect(item.getAttribute('data-carrier-status')).toBe('IN_TRANSIT');
    expect(item.textContent).toContain('IN_TRANSIT');
    expect(item.textContent).toContain('Amazon · getPackageTrackingDetails · 09:31:07');
    expect(host.querySelectorAll('[data-testid="observation"]')).toHaveLength(20);
    expect(host.querySelector('[data-testid="observation-count"]')?.textContent).toBe('20 of 23');
    expect(host.querySelector('[data-testid="amazon-shipment"]')?.getAttribute('data-status')).toBe('SHIPPED');
  });

  it('raises the carrier failure instead of the wait when a live package is returning', () => {
    const lane = { ...inTransit.props.detail.lane!, packages: [{ ...inTransit.props.detail.lane!.packages![0]!, carrierStatus: 'RETURNING' }] };
    const host = rendered(<Screen data={{ view: 'ready', props: { detail: { ...inTransit.props.detail, lane } } }} />);
    expect(host.querySelectorAll('[data-testid="carrier-failed"]')).toHaveLength(1);
    expect(host.querySelector('[data-testid="carrier-failed"]')?.textContent).toContain('The carrier reports the parcel is not reaching the creator.');
    expect(host.querySelector('[data-testid="not-safe-to-send"]')).toBeNull();
    expect(rendered(<Screen data={inTransit} />).querySelector('[data-testid="carrier-failed"]')).toBeNull();
  });

  it('never prints a probe count past the threshold as n of 3', () => {
    expect([0, 2, 3, 4].map(probeCount)).toEqual(['0 of 3', '2 of 3', '3 (only an ambiguous submit escalates)', '4 (only an ambiguous submit escalates)']);
    const confirmed = { view: 'ready' as const, props: { detail: { ...inTransit.props.detail, lane: { ...inTransit.props.detail.lane!, mcf: null, packages: null },
      settlement: { settlement: 'not_found' as const, notFoundProbes: 4, lastProbeAt: '2026-09-10T09:31:07.000Z' } } } };
    const host = rendered(<Screen data={confirmed} />);
    expect(host.textContent).not.toContain('4 of 3');
    expect(host.textContent).toContain('not found on 4 (only an ambiguous submit escalates) reads running');
  });

  it('says so when the array holds more than one shipment', () => {
    const second = { ...pendingShipment, amazonShipmentId: 'SYNTHETIC-SHIP-0088-B' };
    const host = rendered(<Screen data={{ view: 'ready', props: { detail: { ...trackingNotSafe.props.detail,
      shipments: [{ ...pendingShipment, status: 'CANCELLED_BY_FULFILLER' }, second] } } }} />);
    expect(host.querySelectorAll('[data-testid="amazon-shipment"]')).toHaveLength(2);
    expect(host.querySelector('[data-testid="split-shipments"]')?.textContent).toContain('Amazon lists 2 shipments for this order.');
    expect(texts(host, '[data-testid="amazon-facts"] [data-fact="shipments"]')).toEqual(['2']);
  });

  it('never renders an unread Amazon value as zero', () => {
    const lane = { ...processing, feeCents: null, feeCapCents: null, packages: null };
    const host = rendered(<Screen data={{ view: 'ready', props: { detail: { ...trackingNotSafe.props.detail, lane, shipments: null } } }} />);
    expect(texts(host, '[data-testid="amazon-facts"] [data-fact]')).toEqual(['Processing Amazon · getFulfillmentOrder · 07:02:18', 'not read']);
    expect(host.querySelector('[data-testid="packages-not-read"]')?.textContent).toBe('Packages: not read from Amazon.');
    expect(answers(host, '[data-testid="stage"]')).toEqual(['now', 'not_read', 'not_read', 'not_read']);
    expect(texts(host, '[data-testid="stage"] .wa-badge').filter((text) => text === 'not read')).toHaveLength(3);
    expect(host.querySelectorAll('[data-testid="amazon-shipment"], [data-testid="amazon-package"]')).toHaveLength(0);
    for (const value of texts(host, '[data-fact]')) expect(value).not.toMatch(/^0(\.00)?$/);
    const unread = rendered(<Screen data={{ view: 'ready', props: { detail: { ...notMeasured.props.detail, lane: { ...ambiguous, feeCents: null, feeCapCents: null } } } }} />);
    expect(texts(unread, '[data-fact="fee"]')).toEqual(['not recorded']);
    expect(unread.textContent).not.toContain('0.00');
  });
});

describe('sample order: controls', () => {
  it('renders no action button in any state', () => {
    const all = [notMeasured, notFound, escalated, trackingNotSafe, inTransit, empty, missing, refused];
    expect(all).toHaveLength(8);
    for (const data of all) {
      const host = rendered(<Screen data={data} />);
      expect(host.querySelectorAll('button')).toHaveLength(0);
      expect(host.textContent).not.toContain('OSCC-');
    }
  });

  it('keeps only the key and the refusal on a failed read', () => {
    const host = rendered(<Screen data={refused} />);
    expect(host.querySelector('[data-creator-state="refused"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="order-key"]')?.textContent).toBe(ambiguous.derivedOrderKey);
    expect(host.textContent).not.toContain('Reconciliation Required');
    expect(host.querySelectorAll('[data-testid="question"], [data-testid="stage"], [data-testid="observation"]')).toHaveLength(0);
  });
});

describe('Arcana\'s send outcome (WP-338g)', () => {
  const lane = { ...ambiguous, orderOwner: 'arcana' as const };
  const withOutcome = (send: Partial<CreatorMcfLaneSend>, laneState = lane.laneState) => ({ view: 'ready' as const, props: {
    detail: { ...notMeasured.props.detail, lane: { ...lane, laneState } }, send: { ...SEND, custodyExpiresAt: null, latestPreview: null, ...send } } });
  const facts = (host: HTMLElement) => Object.fromEntries([...host.querySelectorAll('[data-testid="arcana-facts"] [data-fact]')]
    .map((cell) => [cell.getAttribute('data-fact'), cell.textContent]));

  it('shows each outcome state with Amazon\'s status and codes, and points to the pre-flight for the controls', () => {
    const cases: [CreatorMcfSendState, Partial<CreatorMcfLaneSend>, string][] = [
      ['accepted', { acceptedAt: '2026-09-08T06:44:13.000Z' }, 'That is not placed'],
      ['placed', { amazonStatus: 'Received', placedAt: '2026-09-08T06:50:00.000Z' }, 'with this SKU and one unit'],
      ['uncertain', {}, 'no second order is requested'],
      ['conflict', { amazonStatus: 'Planning', escalationReason: 'conflict' }, 'does not match the send'],
      ['rejected', { providerCodes: ['InvalidInput'], providerStatus: 400 }, 'rejected the order request'],
      ['not_created', {}, 'Released as not created'],
      ['failed_by_amazon', { amazonStatus: 'Invalid' }, 'failed status'],
      ['failed_after_placement', { amazonStatus: 'Unfulfillable' }, 'Cancelled or Unfulfillable'],
    ];
    for (const [state, send, words] of cases) {
      const host = rendered(<Screen data={withOutcome({ state, ...send })} />);
      const panel = host.querySelector('[data-testid="arcana-outcome"]')!;
      expect(panel.querySelector('[data-send-state]')?.getAttribute('data-send-state')).toBe(state);
      expect(facts(host)['outcome']).toContain(words);
      expect(panel.querySelector('[data-testid="arcana-controls-link"]')?.getAttribute('href')).toBe(`/creators/samples/${lane.derivedOrderKey}/preflight`);
      expect(panel.querySelectorAll('button')).toHaveLength(0);
    }
    const rejected = rendered(<Screen data={withOutcome({ state: 'rejected', providerCodes: ['InvalidInput'] })} />);
    expect(facts(rejected)['codes']).toBe('InvalidInput ');
    const placed = rendered(<Screen data={withOutcome({ state: 'placed', amazonStatus: 'Received', placedAt: '2026-09-08T06:50:00.000Z' })} />);
    expect(facts(placed)['amazon-status']).toBe('Received');
    expect(facts(rejected)['placed']).toBe('not placed');
  });

  it('flags a ladder that ran out, and says the ledger, not the runner, owns an Arcana lane', () => {
    const host = rendered(<Screen data={withOutcome({ state: 'accepted', escalationReason: 'ladder_exhausted' })} />);
    expect(host.querySelector('[data-testid="arcana-escalation"]')?.textContent).toBe('Amazon has not settled this order in 7 days.');
    expect(host.querySelector('[data-testid="lock-line"]')?.textContent).toContain('Arcana\'s send ledger owns this lane\'s state');
    expect(host.querySelector('[data-testid="creator-fulfillment"]')?.getAttribute('data-owner')).toBe('arcana');
  });

  it('draws no outcome panel for a runner lane', () => {
    const host = rendered(<Screen data={notMeasured} />);
    expect(host.querySelector('[data-testid="arcana-outcome"]')).toBeNull();
    expect(host.querySelector('[data-testid="lock-line"]')?.textContent).toContain('The runner owns the lane state and the lock;');
  });
});

describe('Arcana\'s cancel, read-only (WP-338i)', () => {
  const lane = { ...ambiguous, orderOwner: 'arcana' as const, laneState: 'Confirmed' as typeof ambiguous.laneState };
  const withCancel = (send: Partial<CreatorMcfLaneSend>, laneChange: Partial<typeof lane> = {}) => ({ view: 'ready' as const, props: {
    detail: { ...notMeasured.props.detail, lane: { ...lane, ...laneChange } },
    send: { ...SEND, state: 'placed' as const, amazonStatus: 'Received' as const, placedAt: '2026-09-08T06:50:00.000Z', custodyExpiresAt: null,
      latestPreview: null, ...send } } });
  const cancelFact = (host: HTMLElement) => host.querySelector('[data-testid="arcana-facts"] [data-fact="cancel"]');
  const cancelKey = (host: HTMLElement) => host.querySelector('[data-testid="arcana-cancel"]')?.getAttribute('data-cancel') ?? null;
  const link = (host: HTMLElement) => host.querySelector('[data-testid="cancel-link"]');
  const ended = { ...OPEN_CANCEL, endedAt: '2026-09-08T07:00:00.000Z' };

  it('links a placed or conflicting order still Received or Planning to the send page for the cancel, as a plain link', () => {
    const cases = [[{}, true], [{ amazonStatus: 'Planning' as const }, true], [{ state: 'conflict' as const }, true],
      [{ amazonStatus: 'Processing' as const }, false], [{ amazonStatus: 'New' as const }, false], [{ state: 'accepted' as const }, false],
      [{ cancel: OPEN_CANCEL }, false]] as const;
    expect(cases).toHaveLength(7);
    const shown = cases.map(([send]) => {
      const host = rendered(<Screen data={withCancel(send)} />);
      expect(host.querySelectorAll('button')).toHaveLength(0);
      return link(host) !== null;
    });
    expect(shown).toEqual(cases.map(([, expected]) => expected));
    const host = rendered(<Screen data={withCancel({})} />);
    expect(link(host)?.tagName).toBe('A');
    expect(link(host)?.getAttribute('href')).toBe(`/creators/samples/${lane.derivedOrderKey}/preflight`);
    expect(link(host)?.textContent).toBe('Cancel on the send page');
    expect(host.querySelector('[data-testid="cancel-link-line"]')?.textContent).toContain('Amazon holds this order as Received, so it can still be cancelled.');
    // No cancel was pressed: no cancel row, never an invented one.
    expect(cancelFact(host)).toBeNull();
  });

  it('shows each cancel step in words, with no control', () => {
    const cases: [Partial<CreatorMcfLaneSend>, string, string][] = [
      [{ cancel: OPEN_CANCEL }, 'approved', `Cancel approved at ${formatTimestamp(OPEN_CANCEL.approvedAt)}, waiting for the worker.`],
      [{ state: 'cancel_dispatching', cancel: { ...OPEN_CANCEL, reservedAt: '2026-09-08T06:55:00.000Z', providerOutcome: 'accepted', providerStatus: 200 } },
        'dispatching', 'Accepted (HTTP 200). That is not proof'],
      [{ state: 'cancelled', amazonStatus: 'Cancelled', cancel: { ...ended, ending: 'cancelled', endingReason: 'operator_cancelled_in_amazon' } }, 'cancelled',
        'Amazon cancelled the order at Arcana\'s request.'],
      [{ amazonStatus: 'Processing', cancel: { ...ended, providerOutcome: 'accepted', providerStatus: 200, ending: 'not_honoured', endingReason: 'processing' } },
        'not_honoured', 'Amazon did not cancel: the order reached Processing.'],
      [{ cancel: { ...ended, ending: 'refused', endingReason: 'status_new' } }, 'refused', 'Amazon has not validated this order yet (New)'],
      [{ cancel: { ...ended, ending: 'expired', endingReason: 'claim_deadline' } }, 'expired', 'nothing was sent to Amazon'],
      [{ cancel: { ...ended, ending: NOT_SENT, endingReason: 'rejected_authorization' } }, 'not_sent',
        'Amazon refused the cancel request for authorization (HTTP 401 or 403), so nothing changed at Amazon. The order can be cancelled again'],
      [{ state: 'cancel_dispatching', cancel: { ...ended, originState: 'conflict', reservedAt: '2026-09-08T06:55:00.000Z', ending: NOT_SENT,
        endingReason: 'stopping' } }, 'dispatching', 'The worker withheld the cancel request: it was stopping, so nothing changed at Amazon.'],
    ];
    expect(cases).toHaveLength(8);
    for (const [send, key, words] of cases) {
      const host = rendered(<Screen data={withCancel(send)} />);
      expect(cancelKey(host)).toBe(key);
      expect(cancelFact(host)?.textContent).toContain(words);
      expect(host.querySelectorAll('button')).toHaveLength(0);
    }
    const dispatching = rendered(<Screen data={withCancel(cases[1]![0])} />);
    expect(cancelFact(dispatching)?.textContent).toContain(`reserved at ${formatTimestamp('2026-09-08T06:55:00.000Z')}`);
    expect(cancelFact(dispatching)?.textContent).toContain('never sends the request twice');
    // An expired or refused cancel on an order still Received offers the send page again; one Amazon did not honour does not.
    expect(link(rendered(<Screen data={withCancel(cases[5]![0])} />))).not.toBeNull();
    expect(link(rendered(<Screen data={withCancel(cases[3]![0])} />))).toBeNull();
    expect(link(rendered(<Screen data={withCancel(cases[6]![0])} />))).not.toBeNull();
  });

  it('says Arcana asked Amazon to cancel a cancelled order', () => {
    const host = rendered(<Screen data={withCancel({ state: 'cancelled', amazonStatus: 'Cancelled',
      cancel: { ...ended, ending: 'cancelled', endingReason: 'operator_cancelled_in_amazon' } }, { laneState: 'Cancelled' })} />);
    const facts = Object.fromEntries([...host.querySelectorAll('[data-testid="arcana-facts"] [data-fact]')].map((cell) => [cell.getAttribute('data-fact'), cell.textContent]));
    expect(facts['outcome']).toBe('Arcana asked Amazon to cancel this order, and a read showed it Cancelled. The lane is Cancelled.');
    expect(facts['amazon-status']).toBe('Cancelled');
    expect(link(host)).toBeNull();
    for (const state of ['cancel_requested', 'cancel_dispatching'] as const) {
      const pending = rendered(<Screen data={withCancel({ state, cancel: OPEN_CANCEL })} />);
      expect(pending.querySelector('[data-testid="arcana-facts"] [data-fact="outcome"]')?.textContent).toContain(state === 'cancel_requested'
        ? 'Arcana approved a cancel of this order' : 'The worker sent Arcana\'s one cancel request to Amazon');
    }
  });
});
