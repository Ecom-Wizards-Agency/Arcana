// @vitest-environment jsdom
/**
 * Every send state in DESIGN §9 (WP-338g), rendered through the real pre-flight
 * view with synthetic props. Frames: 446:2 (entry, review, sealed card, preview
 * card and the button), 449:221 (stale), 447:2 (outcome unknown).
 */
import { describe, expect, it } from 'vitest';
import { CREATOR_MCF_IRREVERSIBILITY, CREATOR_MCF_SEND_TRANSITIONS, creatorMcfSendConfirmation, type CreatorMcfSendState } from '@wizard-ads/shared';
import { rendered } from '../render-test-support';
import { GATE_OFF, GATE_ON, KEY, KEY_ID, PREVIEW, SEND, arrived, passing, reservedLane, withSend } from './render-fixture';
import { SEND_STATE_WORDS, sendingMissing } from './send-model';
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
      events: arrived('conflict', ['sku_mismatch'], '2026-09-09T06:50:00.000Z', 'accepted') })} />);
    expect(received.querySelector('[data-testid="conflict-banner"]')?.textContent).toContain('sku_mismatch');
    expect(buttons(received)).toEqual(['Ask Amazon for this order id', 'Record as sent', 'Cancel in Amazon']);
    expect(received.querySelector('[data-testid="cancel-in-amazon"]')?.hasAttribute('disabled')).toBe(true);
    const processing = rendered(<Screen data={withSend({ state: 'conflict', amazonStatus: 'Processing', custodyExpiresAt: null })} />);
    expect(buttons(processing)).toEqual(['Ask Amazon for this order id', 'Record as sent']);
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
      expect(buttons(host)).toEqual([]);
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
