// @vitest-environment jsdom
/**
 * Every send state in DESIGN §9 (WP-338g), rendered through the real pre-flight
 * view with synthetic props. Frames: 446:2 (entry, review, sealed card, preview
 * card and the button), 449:221 (stale), 447:2 (outcome unknown).
 */
import { describe, expect, it } from 'vitest';
import {
  CREATOR_MCF_IRREVERSIBILITY, CREATOR_MCF_SEND_TRANSITIONS, creatorMcfCancelConfirmation, creatorMcfSendConfirmation, type CreatorMcfSendState,
} from '@wizard-ads/shared';
import { CREATOR_MCF_REFUSALS, type CreatorMcfLaneCancel } from '@wizard-ads/db';
import { rendered } from '../render-test-support';
import { formatTimestamp } from '../../ui/date-format';
import {
  CANCEL_GATE, CANCEL_PREVIEW, GATE_OFF, GATE_ON, KEY, KEY_ID, LATEST_CANCEL_PREVIEW, NOT_SENT, OPEN_CANCEL, PLACED, PREVIEW, SEND, arrived, passing, reservedLane,
  withSend,
} from './render-fixture';
import { cancelMissing, cancelPreviewCurrent, statusClass } from './cancel-model';
import { REFUSAL_WORDS, SEND_STATE_WORDS, sendingMissing } from './send-model';
import Screen from './view';

const section = (host: HTMLElement) => host.querySelector('[data-testid="mcf-send"]')!;
const card = (host: HTMLElement) => host.querySelector('[data-testid="send-card"]');
const buttons = (host: HTMLElement) => [...section(host).querySelectorAll('button')].map((button) => button.textContent);
const missing = (host: HTMLElement) => [...host.querySelectorAll('[data-testid="sending-off"] [data-missing]')].map((item) => item.getAttribute('data-missing'));

describe('send section: sending on or off', () => {
  it('names every missing element and draws no Send button while sending is off, even over a ready preview', () => {
    const host = rendered(<Screen data={withSend({}, { data: { gate: { ...GATE_OFF, missing: ['connection', 'grant', 'heartbeat'] }, key: { status: 'invalid' } } })} />);
    expect(missing(host)).toEqual(['connection', 'grant', 'heartbeat', 'key_invalid']);
    expect(host.querySelector('[data-testid="sending-off"]')!.textContent).toContain('Sending is off, so there is no Send button.');
    expect(host.querySelector('[data-testid="sending-off"]')!.textContent).toContain('OPENSPELL_MCF_RECIPIENT_PUBLIC_KEY');
    expect(host.querySelector('[data-testid="sending-off"]')!.textContent).toContain('Last heartbeat: never.');
    expect(host.querySelectorAll('[data-testid="send-button"]')).toHaveLength(0);
    expect(host.querySelectorAll('[data-testid="mcf-preview"]')).toHaveLength(1);
    expect(buttons(host)).toEqual(['Withdraw']);
  });

  it('turns on only with an active grant, a parsed key the grant lists and a fresh heartbeat with dispatch on and scope covering', () => {
    expect(sendingMissing(GATE_ON, KEY)).toEqual([]);
    expect(sendingMissing(null, KEY)).toEqual(['unread']);
    expect(sendingMissing(GATE_ON, { status: 'absent' })).toEqual(['key_absent']);
    expect(sendingMissing({ ...GATE_ON, keyIds: ['ab'.repeat(32)] }, KEY)).toEqual(['key_not_granted']);
    expect(sendingMissing({ ...GATE_ON, sendingOn: false, missing: ['scope'] }, KEY)).toEqual(['scope']);
    expect(sendingMissing({ ...GATE_ON, sendingOn: false, missing: ['dispatch_disabled'] }, KEY)).toEqual(['dispatch_disabled']);
    expect(sendingMissing({ ...GATE_ON, heartbeat: { ...GATE_ON.heartbeat!, previewEnabled: false } }, KEY)).toEqual(['preview_disabled']);
    expect(sendingMissing({ ...GATE_ON, sendingOn: false, missing: ['heartbeat'], heartbeat: { ...GATE_ON.heartbeat!, previewEnabled: false } }, KEY))
      .toEqual(['heartbeat']);
    const on = rendered(<Screen data={withSend(null)} />);
    expect(on.querySelector('[data-testid="sending-status"]')?.getAttribute('data-sending')).toBe('on');
    expect(on.querySelector('[data-testid="units-today"]')?.textContent).toBe('Units approved today (UTC): 2 of 5.');
    expect(on.querySelector('[data-testid="sending-off"]')).toBeNull();
  });
});

describe('send section: before an address', () => {
  it('holds the address form until the page hydrates, and states what will be sent and from which tracker row', () => {
    const host = rendered(<Screen data={withSend(null)} />);
    expect(section(host).getAttribute('data-section-state')).toBe('entering');
    const entry = host.querySelector('[data-testid="address-entry"]')!;
    expect(entry.querySelector('[data-testid="address-form-pending"]')).not.toBeNull();
    expect(entry.querySelectorAll('input, select')).toHaveLength(0);
    expect([...entry.querySelectorAll('[data-fact]')].map((cell) => cell.textContent)).toEqual([
      'CCR-SW-26-0088 · tracker row 87', '1 × SW-DERMA-05-FBA (B0D9K3M2QP)', 'Standard', '8.00 USD']);
  });

  it('says a lane the runner has not handed over cannot take an address', () => {
    const confirmed = rendered(<Screen data={withSend(null, { detail: { lane: { ...reservedLane, laneState: 'Confirmed' } } })} />);
    expect(confirmed.querySelector('[data-testid="lane-block"]')?.getAttribute('data-block')).toBe('not_reserved');
    expect(confirmed.querySelector('[data-testid="lane-block"]')?.textContent).toContain('The lane is Confirmed, not Reserved');
    const owned = rendered(<Screen data={withSend(null, { detail: { lane: { ...reservedLane, orderOwner: 'arcana' } } })} />);
    expect(owned.querySelector('[data-testid="lane-block"]')?.getAttribute('data-block')).toBe('arcana_owned');
    for (const host of [confirmed, owned]) expect(host.querySelector('[data-testid="address-entry"]')).toBeNull();
  });

  it('says a pre-flight that is missing or older than 24 hours starts no send', () => {
    const none = rendered(<Screen data={withSend(null, { detail: { preflight: null } })} />);
    expect(none.querySelector('[data-testid="lane-block"]')?.getAttribute('data-block')).toBe('preflight_missing');
    const old = rendered(<Screen data={withSend(null, { now: '2026-09-10T07:00:00.000Z' })} />);
    expect(old.querySelector('[data-testid="lane-block"]')?.textContent).toContain('more than 24 hours ago');
    for (const host of [none, old]) expect(host.querySelector('[data-testid="address-entry"]')).toBeNull();
  });

  it('shows analysts every state with no control', () => {
    for (const data of [withSend(null, { data: { canAct: false } }), withSend({}, { data: { canAct: false } }),
      withSend({ state: 'uncertain' }, { data: { canAct: false } })]) {
      const host = rendered(<Screen data={data} />);
      expect(section(host).querySelectorAll('button')).toHaveLength(0);
      expect(host.querySelector('[data-testid="analyst-note"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="address-entry"]')).toBeNull();
    }
    expect(rendered(<Screen data={withSend({}, { data: { canAct: false } })} />).querySelectorAll('[data-testid="mcf-preview"]')).toHaveLength(1);
  });
});

describe('send section: sealed and previewing', () => {
  it('shows the sealed card with the mask and expiry and no way to reveal the address', () => {
    for (const state of ['sealed', 'previewing'] as const) {
      const host = rendered(<Screen data={withSend({ state, latestPreview: null })} />);
      expect(card(host)?.getAttribute('data-send-state')).toBe(state);
      expect(host.querySelector('[data-testid="sealed-mask"]')?.textContent).toBe('Address sealed · US · 94••• · 2 lines · expires 08:35 UTC');
      expect(host.querySelector('[data-testid="previewing-note"]')).not.toBeNull();
      expect(host.textContent).not.toMatch(/show recipient|reveal/i);
      expect(buttons(host)).toEqual(['Withdraw']);
    }
  });

  it('reads "destination purged" once the mask is gone', () => {
    const host = rendered(<Screen data={withSend({ state: 'sealed', mask: null, latestPreview: null })} />);
    expect(host.querySelector('[data-testid="sealed-mask"]')?.textContent).toBe('Address sealed · destination purged');
  });
});

describe('send section: preview ready (446:2)', () => {
  it('draws what this will do, the per-SKU line and the exact button with Withdraw beside it', () => {
    const host = rendered(<Screen data={withSend({})} />);
    const preview = host.querySelector('[data-testid="mcf-preview"]')!;
    expect(preview.querySelector('h2')?.textContent).toBe('What this will do');
    const facts = Object.fromEntries([...preview.querySelectorAll('[data-fact]')].map((cell) => [cell.getAttribute('data-fact'), cell.textContent]));
    expect(Object.keys(facts)).toHaveLength(10);
    expect(facts['items']).toBe('1 × SW-DERMA-05-FBA (B0D9K3M2QP), total 1 unit');
    expect(facts['shipping']).toBe('Standard shipping, Ship, FillOrKill');
    expect(facts['fee']).toBe('FBAPerUnitFulfillmentFee 5.20 USD + FBATransportationFee 1.00 USD = 6.20 USD, within the 8.00 USD lane cap, within the 15.00 USD grant cap');
    expect(facts['fulfillable']).toBe('yes');
    expect(facts['arrival']).toBe('2026-09-12 to 2026-09-15');
    expect(facts['destination']).toBe('US · 94••• · 2 lines');
    expect(facts['order-id']).toBe(PREVIEW.derivedOrderKey);
    expect(facts['account']).toBe('connection 33800000… · marketplace ATVPDKIKX0DER');
    expect(preview.querySelector('[data-testid="irreversibility"]')?.textContent).toBe(CREATOR_MCF_IRREVERSIBILITY);
    const button = host.querySelector('[data-testid="send-button"]')!;
    expect(button.textContent).toBe(creatorMcfSendConfirmation(PREVIEW.totalUnits));
    expect(button.textContent).toBe('Send 1 unit via Amazon');
    expect(host.querySelector('[data-testid="sku-line"]')?.textContent).toBe('1 × SW-DERMA-05-FBA (B0D9K3M2QP)');
    expect(buttons(host)).toEqual(['Send 1 unit via Amazon', 'Withdraw']);
    // The runner's plan card gives way to Arcana's preview: one "What this will do" on the page.
    expect(host.querySelectorAll('[data-testid="what-this-will-do"]')).toHaveLength(0);
  });

  it('takes the button text from the preview\'s unit count, plural included', () => {
    const two = { ...PREVIEW, items: [{ ...PREVIEW.items[0]!, quantity: 2 }], totalUnits: 2 };
    const host = rendered(<Screen data={withSend({ latestPreview: { ...SEND.latestPreview!, preview: two } })} />);
    expect(host.querySelector('[data-testid="send-button"]')?.textContent).toBe('Send 2 units via Amazon');
    expect(host.querySelector('[data-testid="sku-line"]')?.textContent).toBe('2 × SW-DERMA-05-FBA (B0D9K3M2QP)');
  });

  it('offers Preview again instead of the button once the preview is older than 30 minutes', () => {
    const host = rendered(<Screen data={withSend({}, { now: '2026-09-09T07:07:00.000Z' })} />);
    expect(host.querySelector('[data-testid="send-button"]')).toBeNull();
    expect(host.querySelector('[data-testid="preview-old"]')).not.toBeNull();
    expect(buttons(host)).toEqual(['Withdraw', 'Preview again']);
  });
});

describe('send section: stale (449:221)', () => {
  it('names the values the re-read no longer agrees with, says nothing was sent, and offers a fresh preview', () => {
    const host = rendered(<Screen data={withSend({ state: 'stale', stateReason: 'dispatch_reread_differs', events: arrived('stale', ['fees', 'isFulfillable']) })} />);
    expect(host.querySelector('[data-testid="stale-banner"]')?.textContent).toContain('so nothing was sent');
    expect(host.querySelector('[data-testid="stale-banner"]')?.textContent).toContain('2 values no longer match');
    const rows = [...host.querySelectorAll('[data-testid="stale-row"]')];
    expect(rows).toHaveLength(10);
    expect(rows.filter((row) => row.getAttribute('data-agrees') === 'false').map((row) => row.getAttribute('data-row'))).toEqual(['fulfillable', 'fee']);
    expect(host.querySelector('[data-testid="stale-nothing-ordered"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="send-button"]')).toBeNull();
    expect(buttons(host)).toEqual(['Withdraw', 'Preview again']);
    expect(host.querySelector('[data-testid="stale-product-switch"]')?.getAttribute('href')).toBe(`/creators/samples/${reservedLane.derivedOrderKey}/product-switch`);
  });

  it('never says "agrees" when the ledger recorded no codes, and puts cap codes on the fee row', () => {
    const silent = rendered(<Screen data={withSend({ state: 'stale', stateReason: 'dispatch_reread_differs', events: arrived('stale', []) })} />);
    const rows = [...silent.querySelectorAll('[data-testid="stale-row"]')];
    expect(rows.map((row) => row.getAttribute('data-agrees'))).toEqual(Array(10).fill('unknown'));
    expect(silent.querySelector('[data-testid="stale-banner"]')?.textContent).toContain('The ledger recorded no value names for the difference.');
    const caps = rendered(<Screen data={withSend({ state: 'stale', stateReason: 'caps_changed', events: arrived('stale', ['fee_over_lane_cap']) })} />);
    expect([...caps.querySelectorAll('[data-testid="stale-row"][data-agrees="false"]')].map((row) => row.getAttribute('data-row'))).toEqual(['fee']);
    expect(caps.querySelector('[data-testid="stale-banner"]')?.textContent).toContain('the fee no longer fits the caps');
    const unfulfillable = rendered(<Screen data={withSend({ state: 'stale', stateReason: 'caps_changed', events: arrived('stale', ['not_fulfillable']) })} />);
    expect([...unfulfillable.querySelectorAll('[data-testid="stale-row"][data-agrees="false"]')].map((row) => row.getAttribute('data-row'))).toEqual(['fulfillable']);
    const revoked = rendered(<Screen data={withSend({ state: 'stale', stateReason: 'caps_changed', events: arrived('stale', ['grant_inactive']) })} />);
    expect(new Set([...revoked.querySelectorAll('[data-testid="stale-row"]')].map((row) => row.getAttribute('data-agrees')))).toEqual(new Set(['unknown']));
  });
});

describe('send section: after the press', () => {
  it('approved: waits for the worker with the claim deadline, and can still be withdrawn', () => {
    const host = rendered(<Screen data={withSend({ state: 'approved', approvedAt: '2026-09-09T06:39:00.000Z', claimDeadline: '2026-09-09T06:54:00.000Z', units: 1 })} />);
    expect(host.querySelector('[data-testid="approved-note"]')?.textContent).toContain('by 06:54 UTC the approval expires and nothing is sent');
    expect(buttons(host)).toEqual(['Withdraw']);
    expect(host.querySelector('[data-testid="sealed-card"]')).not.toBeNull();
  });

  it('dispatching: nothing can be withdrawn', () => {
    const host = rendered(<Screen data={withSend({ state: 'dispatching', intentReservedAt: '2026-09-09T06:40:00.000Z' })} />);
    expect(host.querySelector('[data-testid="dispatching-note"]')?.textContent).toContain('It cannot be withdrawn.');
    expect(buttons(host)).toEqual([]);
  });

  it('accepted: HTTP 200 is not placed', () => {
    const host = rendered(<Screen data={withSend({ state: 'accepted', acceptedAt: '2026-09-09T06:40:02.000Z', custodyExpiresAt: null })} />);
    expect(card(host)?.textContent).toContain('Accepted by Amazon');
    expect(host.querySelector('[data-testid="accepted-note"]')?.textContent).toContain('Awaiting validation');
    expect(host.querySelector('[data-testid="sealed-card"]')).toBeNull();
    expect(buttons(host)).toEqual(['Ask Amazon for this order id']);
  });

  it('placed: links to the shipments and carrier scans (449:2)', () => {
    const host = rendered(<Screen data={withSend({ state: 'placed', amazonStatus: 'Received', placedAt: '2026-09-09T06:45:00.000Z', custodyExpiresAt: null })} />);
    expect(host.querySelector('[data-testid="placed-link"]')?.getAttribute('href')).toBe(`/creators/samples/fulfillment/${reservedLane.derivedOrderKey}`);
    expect(buttons(host)).toEqual([]);
  });

  it('rejected: shows Amazon\'s codes', () => {
    const host = rendered(<Screen data={withSend({ state: 'rejected', providerStatus: 400, providerReason: 'validation', providerCodes: ['InvalidInput'], custodyExpiresAt: null })} />);
    expect(host.querySelector('[data-testid="rejected-note"]')?.textContent).toContain('Rejected: InvalidInput (HTTP 400, validation)');
  });

  it('uncertain (447:2): three questions and the three controls, with the release evidence rule', () => {
    const host = rendered(<Screen data={withSend({ state: 'uncertain', stateReason: 'crash', intentReservedAt: '2026-09-09T06:40:00.000Z', providerReason: 'transport',
      custodyExpiresAt: null }, { lane: { settlement: { settlement: 'not_found', notFoundProbes: 2, lastProbeAt: '2026-09-09T06:50:00.000Z' } } })} />);
    expect(host.querySelector('[data-testid="uncertain-banner"]')?.getAttribute('data-escalated')).toBe('false');
    expect(host.querySelectorAll('[data-testid="uncertain-questions"] section')).toHaveLength(3);
    expect(host.querySelector('[data-testid="uncertain-exists"]')?.textContent).toContain('not found on 2 reads');
    expect(buttons(host)).toEqual(['Ask Amazon for this order id', 'Release as not created', 'Leave locked']);
    expect(host.querySelector('[data-testid="release-rule"]')?.textContent).toContain('three not-found reads made after the reservation, over at least 30 minutes');
  });

  it('uncertain, escalated by WP-334: says a person looks', () => {
    const host = rendered(<Screen data={withSend({ state: 'uncertain', custodyExpiresAt: null },
      { lane: { settlement: { settlement: 'escalated', notFoundProbes: 3, lastProbeAt: '2026-09-09T07:10:00.000Z' } } })} />);
    expect(host.querySelector('[data-testid="uncertain-banner"]')?.getAttribute('data-escalated')).toBe('true');
    expect(host.querySelector('[data-testid="uncertain-banner"]')?.textContent).toContain('a person looks');
  });

  it('conflict: Record as sent, and Cancel in Amazon only while Received or Planning', () => {
    const received = rendered(<Screen data={withSend({ state: 'conflict', amazonStatus: 'Received', custodyExpiresAt: null, escalationReason: 'conflict',
      events: arrived('conflict', ['sku_mismatch'], '2026-09-09T06:50:00.000Z', 'accepted') }, { data: { gate: CANCEL_GATE } })} />);
    expect(received.querySelector('[data-testid="conflict-banner"]')?.textContent).toContain('sku_mismatch');
    expect(buttons(received)).toEqual(['Ask Amazon for this order id', 'Record as sent', 'Cancel in Amazon']);
    expect(received.querySelector('[data-testid="cancel-in-amazon"]')?.hasAttribute('disabled')).toBe(false);
    expect(received.textContent).not.toContain('not available in Arcana yet');
    const processing = rendered(<Screen data={withSend({ state: 'conflict', amazonStatus: 'Processing', custodyExpiresAt: null }, { data: { gate: CANCEL_GATE } })} />);
    expect(buttons(processing)).toEqual(['Ask Amazon for this order id', 'Record as sent']);
    expect(processing.querySelector('[data-testid="cancel-not-allowed"]')?.textContent).toContain('Amazon is already picking this unit (Processing)');
  });

  it('ladder exhausted: Amazon has not settled the order in 7 days', () => {
    const host = rendered(<Screen data={withSend({ state: 'accepted', escalationReason: 'ladder_exhausted', escalatedAt: '2026-09-16T06:40:00.000Z',
      custodyExpiresAt: null })} />);
    expect(host.querySelector('[data-testid="ladder-exhausted"]')?.textContent).toContain('Amazon has not settled this order in 7 days.');
    expect(buttons(host)).toEqual(['Ask Amazon for this order id']);
  });
});

describe('send section: endings', () => {
  const ending = (state: CreatorMcfSendState, extra: Parameters<typeof withSend>[0] = {}) =>
    rendered(<Screen data={withSend({ state, custodyExpiresAt: null, ...extra })} />);

  it('preview refused: codes in words, and a new address may be typed', () => {
    const host = ending('preview_refused', { stateReason: 'not_sendable', events: arrived('preview_refused', ['fee_over_lane_cap', 'postalCode.invalid_format'], undefined, 'previewing') });
    expect(host.querySelector('[data-testid="refused-note"]')?.textContent).toContain('the fee is over the lane\'s cap; Postal code has characters Arcana does not accept');
    expect(host.querySelector('[data-testid="address-entry"]')).not.toBeNull();
  });

  it('not created, expired, expired unclaimed and withdrawn: nothing was ordered', () => {
    const cases: [CreatorMcfSendState, string, string][] = [
      ['not_created', 'released', 'not-created-note'], ['expired', 'ttl', 'ended-note'], ['expired_unclaimed', 'claim_deadline', 'ended-note'],
      ['withdrawn', 'operator', 'ended-note']];
    for (const [state, reason, testid] of cases) {
      const host = ending(state, { stateReason: reason });
      expect(card(host)?.getAttribute('data-send-state')).toBe(state);
      expect(host.querySelector(`[data-testid="${testid}"]`)).not.toBeNull();
      expect(host.querySelector('[data-testid="address-entry"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="send-button"]')).toBeNull();
    }
  });

  it('failed by Amazon, failed after placement and the cancel states take no new address', () => {
    for (const [state, testid] of [['failed_by_amazon', 'failed-note'], ['failed_after_placement', 'failed-after-note'], ['cancel_requested', 'cancel-note'],
      ['cancel_dispatching', 'cancel-note'], ['cancelled', 'cancel-note']] as const) {
      const host = ending(state, { amazonStatus: state === 'failed_by_amazon' ? 'Invalid' : 'Cancelled' });
      expect(host.querySelector(`[data-testid="${testid}"]`)).not.toBeNull();
      expect(host.querySelector('[data-testid="address-entry"]')).toBeNull();
      expect(buttons(host)).toEqual(state === 'cancel_dispatching' ? ['Ask Amazon for this order id'] : []);
    }
  });

  it('has words for every state in the send state machine', () => {
    const states = Object.keys(CREATOR_MCF_SEND_TRANSITIONS) as CreatorMcfSendState[];
    expect(states).toHaveLength(21);
    for (const state of states) {
      expect(SEND_STATE_WORDS[state].title.length).toBeGreaterThan(0);
      const host = ending(state);
      expect(card(host)?.getAttribute('data-send-state')).toBe(state);
      expect(card(host)?.textContent).toContain(SEND_STATE_WORDS[state].title);
    }
  });
});

describe('send fixtures', () => {
  it('are synthetic and bound to the pre-flight they show', () => {
    expect(PREVIEW.preflightRunId).toBe(passing.runId);
    expect(KEY.keyId).toBe(KEY_ID);
    expect(SEND.mask).toEqual({ countryCode: 'US', postalPrefix: '94', lines: 2 });
  });
});

describe('send section: the guarded cancel (WP-338i)', () => {
  const cancelSection = (host: HTMLElement) => host.querySelector('[data-testid="mcf-cancel"]');
  const phase = (host: HTMLElement) => cancelSection(host)?.getAttribute('data-cancel-phase');
  const facts = (host: HTMLElement) => Object.fromEntries([...host.querySelectorAll('[data-testid="cancel-preview"] [data-fact]')]
    .map((cell) => [cell.getAttribute('data-fact'), cell.textContent]));
  const placed = (send: Parameters<typeof withSend>[0] = {}, options: Parameters<typeof withSend>[1] = {}) =>
    rendered(<Screen data={withSend({ ...PLACED, ...send }, { ...options, data: { gate: CANCEL_GATE, ...options.data } })} />);
  const ended = (change: Partial<CreatorMcfLaneCancel>): CreatorMcfLaneCancel => ({ ...OPEN_CANCEL, endedAt: '2026-09-09T06:39:30.000Z', ...change });

  it('offers Cancel in Amazon on a placed send while the last known status is Received or Planning', () => {
    for (const status of ['Received', 'Planning'] as const) {
      const host = placed({ amazonStatus: status });
      expect(phase(host)).toBe('idle');
      expect(buttons(host)).toEqual(['Cancel in Amazon']);
      expect(host.querySelector('[data-testid="cancel-in-amazon"]')?.hasAttribute('disabled')).toBe(false);
      expect(host.querySelector('[data-testid="cancel-off"]')).toBeNull();
    }
    // Without a status on the send, the lane's last read decides.
    const lane = placed({ amazonStatus: null }, { lane: { mcfStatus: 'Planning' } });
    expect(buttons(lane)).toEqual(['Cancel in Amazon']);
  });

  it('says Amazon is already picking the unit once the status is Processing or later, and offers no cancel', () => {
    const cases = [['Processing', 'Amazon is already picking this unit (Processing)'], ['Complete', 'Amazon is already picking this unit (Complete)'],
      ['CompletePartialled', 'Amazon is already picking this unit (CompletePartialled)'], ['New', 'Amazon has not validated this order yet (New)'],
      ['Cancelled', 'Amazon holds the order as Cancelled, so there is nothing to cancel.']] as const;
    for (const [status, words] of cases) {
      const host = placed({ amazonStatus: status });
      expect(buttons(host)).toEqual([]);
      expect(host.querySelector('[data-testid="cancel-not-allowed"]')?.getAttribute('data-status')).toBe(status);
      expect(host.querySelector('[data-testid="cancel-not-allowed"]')?.textContent).toContain(words);
    }
    const unread = placed({ amazonStatus: null });
    expect(unread.querySelector('[data-testid="cancel-not-allowed"]')?.textContent).toBe('No Amazon status is recorded for this order, so no cancel is offered.');
    expect(statusClass('Received')).toBe('cancellable');
    expect(statusClass('Processing')).toBe('picking');
    expect(statusClass(null)).toBe('unread');
  });

  it('names what is missing while cancel is off, and needs neither the recipient key nor previews on', () => {
    const noClass = placed({}, { data: { gate: GATE_ON } });
    expect(missing(noClass)).toEqual([]);
    expect([...noClass.querySelectorAll('[data-testid="cancel-off"] [data-missing]')].map((item) => item.getAttribute('data-missing'))).toEqual(['cancel_class']);
    expect(noClass.querySelector('[data-testid="cancel-off"]')?.textContent).toContain('Cancel in Amazon is off, so there is no cancel button.');
    expect(noClass.querySelector('[data-testid="cancel-in-amazon"]')).toBeNull();
    expect(buttons(noClass)).toEqual([]);
    const beat = placed({}, { data: { gate: { ...CANCEL_GATE, sendingOn: false, missing: ['heartbeat', 'scope', 'dispatch_disabled'] } } });
    expect([...beat.querySelectorAll('[data-testid="cancel-off"] [data-missing]')].map((item) => item.getAttribute('data-missing')))
      .toEqual(['heartbeat', 'scope', 'dispatch_disabled']);
    expect(beat.querySelector('[data-testid="cancel-off"]')?.textContent).toContain(`Last heartbeat: ${formatTimestamp(CANCEL_GATE.heartbeat!.beatAt)}.`);
    expect(cancelMissing(CANCEL_GATE)).toEqual([]);
    expect(cancelMissing(GATE_ON)).toEqual(['cancel_class']);
    expect(cancelMissing(GATE_OFF)).toEqual(['grant', 'heartbeat']);
    expect(cancelMissing({ ...GATE_OFF, missing: ['connection', 'grant'] })).toEqual(['connection', 'grant']);
    expect(cancelMissing(null)).toEqual(['unread']);
    // A grant carrying cancel only: the gate lists 'grant' (nothing can be sent), and cancel is still on.
    const cancelOnly = { ...CANCEL_GATE, sendingOn: false, missing: ['grant' as const], actions: ['cancel' as const] };
    expect(cancelMissing(cancelOnly)).toEqual([]);
    expect(buttons(placed({}, { data: { gate: cancelOnly } }))).toEqual(['Cancel in Amazon']);
    expect(cancelMissing({ ...CANCEL_GATE, heartbeat: { ...CANCEL_GATE.heartbeat!, previewEnabled: false } })).toEqual([]);
    const keyless = placed({}, { data: { key: { status: 'absent' } } });
    expect(buttons(keyless)).toEqual(['Cancel in Amazon']);
  });

  it('a queued read: says Arcana is reading the order, with no control', () => {
    const host = placed({ cancelPreviewPending: true });
    expect(phase(host)).toBe('pending');
    expect(host.querySelector('[data-testid="cancel-reading"]')?.textContent).toContain('Reading this order from Amazon before a cancel');
    expect(buttons(host)).toEqual([]);
  });

  it('a refused read: the reason in words and Read again', () => {
    const cases = [
      ['status_processing', 'Amazon is already picking this unit (Processing)'], ['status_complete', 'Amazon is already picking this unit (Complete)'],
      ['status_completepartialled', 'Amazon is already picking this unit (CompletePartialled)'],
      ['status_new', 'Amazon has not validated this order yet (New)'], ['order_not_found', 'Amazon has no order under this id.'],
      ['state_changed', 'The send changed state after the read was asked for'], ['order_shape', 'does not match this send\'s SKU and one unit'],
      ['grant_inactive', 'The grant carrying cancel was revoked or expired while the read was queued.'],
    ] as const;
    expect(cases).toHaveLength(8);
    for (const [reason, words] of cases) {
      const host = placed({ cancelPreviewRefusal: { reason, codes: [], at: '2026-09-09T06:39:00.000Z' } });
      expect(phase(host)).toBe('read_refused');
      expect(host.querySelector('[data-testid="cancel-read-refused"]')?.getAttribute('data-reason')).toBe(reason);
      expect(host.querySelector('[data-testid="cancel-read-refused"]')?.textContent).toContain(words);
      expect(buttons(host)).toEqual(['Read again']);
      expect(host.querySelector('[data-testid="cancel-button"]')).toBeNull();
    }
    const off = placed({ cancelPreviewRefusal: { reason: 'status_new', codes: [], at: '2026-09-09T06:39:00.000Z' } }, { data: { gate: GATE_ON } });
    expect(buttons(off)).toEqual([]);
    expect(off.querySelector('[data-testid="cancel-off"]')).not.toBeNull();
  });

  it('a current cancel preview: the order, its status, the items, the read and the exact button', () => {
    const host = placed({ latestCancelPreview: LATEST_CANCEL_PREVIEW });
    expect(phase(host)).toBe('preview');
    const card = host.querySelector('[data-testid="cancel-preview"]')!;
    expect(card.getAttribute('data-current')).toBe('true');
    expect(card.querySelector('h2')?.textContent).toBe('What the cancel will do');
    const shown = facts(host);
    expect(Object.keys(shown)).toHaveLength(6);
    expect(shown['order-id']).toBe(CANCEL_PREVIEW.derivedOrderKey);
    expect(shown['status']).toBe('Received');
    expect(shown['items']).toBe('1 × SW-DERMA-05-FBA');
    expect(shown['total']).toBe('1 unit');
    expect(shown['read']).toBe(`Amazon · getFulfillmentOrder · ${formatTimestamp(CANCEL_PREVIEW.readAt)}`);
    expect(shown['valid-until']).toBe(formatTimestamp(CANCEL_PREVIEW.validUntil));
    expect(card.querySelector('[data-testid="cancel-meaning"]')?.textContent)
      .toBe('A cancel asks Amazon to stop this order, and Amazon can still refuse it if picking starts first.');
    const button = host.querySelector('[data-testid="cancel-button"]')!;
    expect(button.textContent).toBe(creatorMcfCancelConfirmation(1));
    expect(button.textContent).toBe('Cancel 1 order in Amazon');
    expect(buttons(host)).toEqual(['Cancel 1 order in Amazon']);
    // A conflict takes the same card beside its own controls.
    const conflict = placed({ state: 'conflict', latestCancelPreview: LATEST_CANCEL_PREVIEW });
    expect(buttons(conflict)).toEqual(['Ask Amazon for this order id', 'Record as sent', 'Cancel 1 order in Amazon']);
  });

  it('a cancel preview past 5 minutes: too old, Read again, and no cancel button', () => {
    const host = placed({ latestCancelPreview: LATEST_CANCEL_PREVIEW }, { now: '2026-09-09T06:43:00.000Z' });
    expect(host.querySelector('[data-testid="cancel-preview"]')?.getAttribute('data-current')).toBe('false');
    expect(host.querySelector('[data-testid="cancel-preview-old"]')?.textContent).toContain('older than 5 minutes');
    expect(host.querySelector('[data-testid="cancel-button"]')).toBeNull();
    expect(buttons(host)).toEqual(['Read again']);
    expect(cancelPreviewCurrent({ readAt: '2026-09-09T06:38:00.000Z', validUntil: '2026-09-09T06:48:00.000Z' }, '2026-09-09T06:42:59.000Z')).toBe(true);
    expect(cancelPreviewCurrent({ readAt: '2026-09-09T06:38:00.000Z', validUntil: '2026-09-09T06:48:00.000Z' }, '2026-09-09T06:43:00.000Z')).toBe(false);
    expect(cancelPreviewCurrent({ readAt: '2026-09-09T06:38:00.000Z', validUntil: '2026-09-09T06:40:00.000Z' }, NOW_AT_VALID_UNTIL)).toBe(false);
  });

  it('an approved cancel the worker has not taken: approved at, the claim deadline, then expired with nothing sent', () => {
    const host = placed({ cancel: OPEN_CANCEL, latestCancelPreview: LATEST_CANCEL_PREVIEW });
    expect(phase(host)).toBe('open');
    const note = host.querySelector('[data-testid="cancel-approved"]')!;
    expect(note.getAttribute('data-expired')).toBe('false');
    expect(note.textContent).toContain(`Cancel approved at ${formatTimestamp(OPEN_CANCEL.approvedAt)}`);
    expect(note.textContent).toContain('by 06:54 UTC the cancel expires and nothing is sent to Amazon');
    expect(buttons(host)).toEqual([]);
    expect(card(host)?.getAttribute('data-send-state')).toBe('placed');
    const late = placed({ cancel: OPEN_CANCEL }, { now: '2026-09-09T06:55:00.000Z' });
    expect(late.querySelector('[data-testid="cancel-approved"]')?.getAttribute('data-expired')).toBe('true');
    expect(late.querySelector('[data-testid="cancel-approved"]')?.textContent).toContain('so nothing was sent to Amazon');
    // Until the ledger's sweep ends it, an expired cancel still reads as open; a new read is the way on.
    expect(buttons(late)).toEqual(['Read again']);
    expect(buttons(placed({ cancel: OPEN_CANCEL, amazonStatus: 'Processing' }, { now: '2026-09-09T06:55:00.000Z' }))).toEqual([]);
  });

  it('cancel dispatching: reserved at, Amazon\'s answer so far, and never a second request', () => {
    const reserved = { ...OPEN_CANCEL, reservedAt: '2026-09-09T06:40:30.000Z' };
    const cases: [Partial<CreatorMcfLaneCancel>, string][] = [
      [{}, 'No answer recorded yet.'],
      [{ providerOutcome: 'accepted', providerStatus: 200 }, 'Accepted (HTTP 200). That is not proof: only a read showing Cancelled settles it.'],
      [{ providerOutcome: 'uncertain', providerReason: 'transport' }, 'No answer Arcana can read as accepted or rejected (transport).'],
      [{ providerOutcome: 'rejected', providerStatus: 400, providerReason: 'validation', providerCodes: ['InvalidInput'] }, 'Rejected: InvalidInput (HTTP 400, validation).'],
    ];
    for (const [change, answer] of cases) {
      const host = rendered(<Screen data={withSend({ ...PLACED, state: 'cancel_dispatching', cancel: { ...reserved, ...change } }, { data: { gate: CANCEL_GATE } })} />);
      const facts = Object.fromEntries([...host.querySelectorAll('[data-testid="cancel-dispatching"] [data-fact]')].map((cell) => [cell.getAttribute('data-fact'), cell.textContent]));
      expect(facts).toEqual({ approved: formatTimestamp(OPEN_CANCEL.approvedAt), reserved: formatTimestamp(reserved.reservedAt), answer });
      expect(host.querySelector('[data-testid="cancel-note"]')?.textContent).toContain('never sends the request a second time');
      expect(buttons(host)).toEqual(['Ask Amazon for this order id']);
      expect(host.querySelector('[data-testid="mcf-cancel"]')).toBeNull();
      expect(host.querySelector('[data-testid="cancel-not-sent"]')).toBeNull();
    }
  });

  it('cancelled: at Arcana\'s request, and the lane is Cancelled with operator_cancelled_in_amazon', () => {
    const host = rendered(<Screen data={withSend({ ...PLACED, state: 'cancelled', amazonStatus: 'Cancelled',
      cancel: { ...OPEN_CANCEL, reservedAt: '2026-09-09T06:40:30.000Z', providerOutcome: 'accepted', providerStatus: 200, endedAt: '2026-09-09T06:42:00.000Z',
        ending: 'cancelled', endingReason: 'operator_cancelled_in_amazon' } }, { data: { gate: CANCEL_GATE }, detail: { lane: { ...reservedLane, laneState: 'Cancelled' } },
      lane: { laneState: 'Cancelled' } })} />);
    const note = host.querySelector('[data-testid="cancel-note"]')!;
    expect(note.textContent).toContain('Cancelled in Amazon at Arcana\'s request');
    expect(note.textContent).toContain(`a read showing Cancelled was recorded at ${formatTimestamp('2026-09-09T06:42:00.000Z')}`);
    expect(note.textContent).toContain('The lane is Cancelled with the reason operator_cancelled_in_amazon.');
    expect(buttons(host)).toEqual([]);
  });

  it('an ended cancel on a placed send: refused, expired or not honoured, and the offer again only under the rule', () => {
    const refused = placed({ cancel: ended({ ending: 'refused', endingReason: 'status_processing' }), amazonStatus: 'Processing' });
    expect(refused.querySelector('[data-testid="cancel-ended"]')?.getAttribute('data-ending')).toBe('refused');
    expect(refused.querySelector('[data-testid="cancel-ended"]')?.textContent).toContain('The cancel was refused before any request reached Amazon. Amazon is already picking this unit (Processing)');
    expect(buttons(refused)).toEqual([]);
    const lost = placed({ cancel: ended({ ending: 'refused', endingReason: 'grant_revoked' }) });
    expect(lost.querySelector('[data-testid="cancel-ended"]')?.textContent).toContain('The grant carrying cancel was revoked or replaced after the approval.');
    expect(buttons(lost)).toEqual(['Cancel in Amazon']);
    const expired = placed({ cancel: ended({ ending: 'expired', endingReason: 'claim_deadline' }), latestCancelPreview: LATEST_CANCEL_PREVIEW });
    expect(expired.querySelector('[data-testid="cancel-ended"]')?.textContent).toContain('the worker did not take it by its deadline, so nothing was sent to Amazon');
    // The preview read before that cancel was pressed belongs to it: no button on it, only the offer to read again.
    expect(phase(expired)).toBe('idle');
    expect(expired.querySelector('[data-testid="cancel-button"]')).toBeNull();
    expect(buttons(expired)).toEqual(['Cancel in Amazon']);
    const kept = placed({ amazonStatus: 'Processing', cancel: ended({ reservedAt: '2026-09-09T06:39:10.000Z', providerOutcome: 'accepted', providerStatus: 200,
      ending: 'not_honoured', endingReason: 'processing' }) });
    expect(kept.querySelector('[data-testid="cancel-ended"]')?.textContent).toContain('Amazon did not cancel: the order reached Processing.');
    expect(kept.querySelector('[data-testid="cancel-ended"]')?.textContent).toContain('Accepted (HTTP 200). That is not proof');
    expect(buttons(kept)).toEqual([]);
    expect(kept.querySelector('[data-testid="cancel-not-allowed"]')?.textContent).toContain('Amazon is already picking this unit (Processing)');
    const complete = placed({ amazonStatus: 'Complete', cancel: ended({ ending: 'not_honoured', endingReason: 'completepartialled' }) });
    expect(complete.querySelector('[data-testid="cancel-ended"]')?.textContent).toContain('Amazon did not cancel: the order reached CompletePartialled.');
  });

  it('a cancel request that did not take (not_sent) on a placed send: nothing changed at Amazon, and the offer again under the rule', () => {
    const reasons = [
      ['rejected_throttled', 'Amazon throttled the cancel request (HTTP 429), so nothing changed at Amazon.'],
      ['rejected_authorization', 'Amazon refused the cancel request for authorization (HTTP 401 or 403), so nothing changed at Amazon.'],
      ['reservation_mismatch', 'the reservation did not match the approved cancel'], ['stopping', 'it was stopping'],
      ['policy_off', 'cancel is switched off in the worker'], ['lease_budget', 'too little time was left on its lease'],
      ['token_unavailable', 'it had no Amazon access token'], ['request_invalid', 'the request failed its own checks'],
      ['cancel_failed', 'it could not be built or sent'],
    ] as const;
    expect(reasons).toHaveLength(9);
    for (const [reason, words] of reasons) {
      const host = placed({ cancel: ended({ reservedAt: '2026-09-09T06:39:10.000Z', ending: NOT_SENT, endingReason: reason }) });
      const note = host.querySelector('[data-testid="cancel-ended"]')!;
      expect(note.getAttribute('data-ending')).toBe('not_sent');
      expect(note.getAttribute('data-reason')).toBe(reason);
      expect(note.textContent).toContain('Last cancel not sent');
      expect(note.textContent).toContain(words);
      expect(note.textContent).toContain('nothing changed at Amazon. The order can be cancelled again while it is Received or Planning.');
      expect(buttons(host)).toEqual(['Cancel in Amazon']);
    }
    const picking = placed({ amazonStatus: 'Processing', cancel: ended({ ending: NOT_SENT, endingReason: 'rejected_throttled' }) });
    expect(buttons(picking)).toEqual([]);
    expect(picking.querySelector('[data-testid="cancel-not-allowed"]')?.textContent).toContain('Amazon is already picking this unit (Processing)');
  });

  it('a conflict cancel recorded as not taken before WP-338p (still cancel dispatching) says why it waits, and offers Ask Amazon', () => {
    const conflictCancel = { ...OPEN_CANCEL, originState: 'conflict' as const, reservedAt: '2026-09-09T06:40:30.000Z' };
    const endedNotSent = rendered(<Screen data={withSend({ ...PLACED, state: 'cancel_dispatching', cancel: { ...conflictCancel, providerOutcome: 'rejected',
      providerStatus: 429, providerReason: 'throttled', providerCodes: ['QuotaExceeded'], endedAt: '2026-09-09T06:40:31.000Z', ending: NOT_SENT,
      endingReason: 'rejected_throttled' } }, { data: { gate: CANCEL_GATE } })} />);
    const note = endedNotSent.querySelector('[data-testid="cancel-not-sent"]')!;
    expect(note.getAttribute('data-reason')).toBe('rejected_throttled');
    expect(note.textContent).toContain('Amazon throttled the cancel request (HTTP 429), so nothing changed at Amazon.');
    expect(note.textContent).toContain('This cancel was recorded before a conflict whose cancel did not take went straight back to conflict');
    expect(note.textContent).toContain('this send waits here for a read of the order: ask Amazon for this order id.');
    expect(buttons(endedNotSent)).toEqual(['Ask Amazon for this order id']);
    // Only the ledger event recorded it: the words still say the request did not take.
    const byEvent = rendered(<Screen data={withSend({ ...PLACED, state: 'cancel_dispatching', cancel: conflictCancel, events: [{ event: 'cancel_not_sent',
      actorType: 'worker', beforeState: 'cancel_dispatching', afterState: 'cancel_dispatching', reason: 'stopping', codes: [], httpStatus: null,
      at: '2026-09-09T06:40:31.000Z' }] }, { data: { gate: CANCEL_GATE } })} />);
    expect(byEvent.querySelector('[data-testid="cancel-not-sent"]')?.textContent).toContain('The cancel request did not take, so nothing changed at Amazon.');
  });

  it('shows analysts every cancel step with no control', () => {
    const cases = [
      withSend({ ...PLACED }, { data: { gate: CANCEL_GATE, canAct: false } }),
      withSend({ ...PLACED, cancelPreviewPending: true }, { data: { gate: CANCEL_GATE, canAct: false } }),
      withSend({ ...PLACED, latestCancelPreview: LATEST_CANCEL_PREVIEW }, { data: { gate: CANCEL_GATE, canAct: false } }),
      withSend({ ...PLACED, cancelPreviewRefusal: { reason: 'status_processing', codes: [], at: '2026-09-09T06:39:00.000Z' } }, { data: { gate: CANCEL_GATE, canAct: false } }),
      withSend({ ...PLACED, cancel: OPEN_CANCEL }, { data: { gate: CANCEL_GATE, canAct: false } }),
      withSend({ ...PLACED, state: 'conflict', latestCancelPreview: LATEST_CANCEL_PREVIEW }, { data: { gate: CANCEL_GATE, canAct: false } }),
    ];
    expect(cases).toHaveLength(6);
    const phases = cases.map((data) => {
      const host = rendered(<Screen data={data} />);
      expect(section(host).querySelectorAll('button')).toHaveLength(0);
      expect(host.querySelector('[data-testid="cancel-off"]')).toBeNull();
      return phase(host);
    });
    expect(phases).toEqual(['idle', 'pending', 'preview', 'read_refused', 'open', 'preview']);
    expect(rendered(<Screen data={cases[2]!} />).querySelector('[data-testid="cancel-preview"]')).not.toBeNull();
  });

  it('has words for every ledger refusal, the six cancel refusals included', () => {
    expect(CREATOR_MCF_REFUSALS).toHaveLength(46);
    for (const reason of CREATOR_MCF_REFUSALS) expect(REFUSAL_WORDS[reason].length).toBeGreaterThan(10);
    const cancel = ['send_not_cancellable', 'cancel_open', 'cancel_grant_inactive', 'cancel_preview_expired', 'order_not_cancellable', 'observation_stale'] as const;
    expect(new Set(cancel.map((reason) => REFUSAL_WORDS[reason])).size).toBe(6);
    expect(REFUSAL_WORDS.cancel_preview_expired).toContain('older than 5 minutes');
  });
});

const NOW_AT_VALID_UNTIL = '2026-09-09T06:40:00.000Z';
