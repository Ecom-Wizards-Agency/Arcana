// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { CreatorSampleOrderKey } from '@wizard-ads/shared';
import Loading from '../../../app/creators/samples/[id]/preflight/loading';
import SharedError from '../../../app/creators/samples/[id]/preflight/error';
import { rendered } from '../render-test-support';
import { verifyScreen } from '../settings/render-support';
import { descriptor } from './descriptor';
import { sampleOrderKeyParam } from './order-key';
import { NOW, held, heldAtStock, malformed, notMeasured, nothingHeld, passing, ready, refused, stale } from './render-fixture';
import Screen, { checkState, merchantFulfilled, previewValidity } from './view';

verifyScreen(descriptor, [
  { state: 'loading', name: 'renders the route loading boundary', render: () => <Loading />, text: '' },
  { state: 'error', name: 'renders the shared error boundary with its reference', render: () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-reference' })} reset={() => { }} />, text: 'synthetic-reference' },
  { state: 'error', name: 'preserves the safe read error message', render: () => <Screen data={{ view: 'error', props: { message: 'Synthetic read unavailable' } }} />, text: 'Synthetic read unavailable' },
  { state: 'ready', name: 'draws eight checks held in one run and the order it would place (446:2)', render: () => <Screen data={ready} />, text: 'All eight checks held in run preflight-0088-20260909' },
  { state: 'ready', name: 'names the check a held pre-flight stopped at (446:313)', render: () => <Screen data={heldAtStock} />, text: 'Held at check seven: selected_sku_not_mcf_fulfillable' },
  { state: 'stale', name: 'says an expired preview sent nothing and a new pre-flight is needed', render: () => <Screen data={stale} />, text: 'The preview expired, so nothing was sent.', absent: ['[data-testid="preflight-pass"]'] },
  { state: 'refused', name: 'withholds the pre-flight when the last read failed', render: () => <Screen data={refused} />, text: 'Nothing was read', absent: ['[data-testid="preflight-checks"]'] },
  { state: 'not-measured', name: 'says a lane without a recorded pre-flight has neither passed nor been held', render: () => <Screen data={notMeasured} />, text: 'so it has neither passed nor been held', absent: ['[data-testid="preflight-checks"]'] },
  { state: 'empty', name: 'says nothing in the organisation carries the key', render: () => <Screen data={nothingHeld} />, text: 'No sample lane or pre-flight in this organisation carries' },
  { state: 'empty', name: 'says a malformed address names no key', render: () => <Screen data={malformed} />, text: 'This address does not name a sample order key.' },
  { state: 'gated', name: 'keeps viewers out', render: () => <Screen data={{ view: 'gated', props: {} }} />, text: 'Owners, admins and analysts only' },
]);

const rows = (host: HTMLElement) => [...host.querySelectorAll('[data-testid="preflight-check"]')];

describe('sample pre-flight', () => {
  it('draws all eight checks in order with read time and evidence, and the order the run would place', () => {
    const host = rendered(<Screen data={ready} />);
    expect(host.querySelector('[data-status="run-by-hand"]')?.textContent).toBe('Run by hand');
    const checks = rows(host);
    expect(checks).toHaveLength(8);
    expect(checks.map((row) => row.getAttribute('data-check'))).toEqual(['identity', 'qualification', 'agreement', 'recipient', 'no_prior_sample',
      'quantity_shipping_fee', 'fulfillable_stock', 'form']);
    expect(checks.filter((row) => row.getAttribute('data-outcome') === 'pass')).toHaveLength(8);
    expect(checks[0]!.textContent).toContain('1 · Identity resolves, exactly one active record');
    expect(checks[0]!.textContent).toContain('06:33:04');
    expect(checks[0]!.textContent).toContain('ev:identity-0088');
    expect(checks[5]!.textContent).toContain('Fee 6.20 EUR, within the 8.00 EUR cap');
    expect(checks[6]!.querySelector('[data-testid="fulfillable-units"]')?.textContent).toBe('Fulfillable units: 37');
    expect(host.querySelectorAll('[data-read="not-recorded"]')).toHaveLength(0);
    const plan = host.querySelector('[data-testid="what-this-will-do"]')!;
    expect([...plan.querySelectorAll('dt')].map((cell) => cell.textContent)).toEqual(['Creator record', 'Campaign', 'Product', 'ASIN and SKU', 'Quantity',
      'Shipping', 'Fee', 'Order id · derived']);
    expect([...plan.querySelectorAll('dd')].map((cell) => cell.textContent)).toEqual(['CCR-SW-26-0088', 'Derma stamp 2026 · tracker row 87',
      'Derma stamp roller, 0.5mm', 'B0D9K3M2QP · SW-DERMA-05-FBA', '1 unit', 'Standard', '6.20 EUR, within the 8.00 EUR cap', passing.derivedOrderKey]);
    expect(host.querySelector('[data-testid="preview"]')?.textContent).toContain('It is current until 9 Sep');
    expect(host.querySelector('[data-testid="preflight-links"] a[href^="/creators/samples/fulfillment/"]')?.getAttribute('href'))
      .toBe(`/creators/samples/fulfillment/${passing.derivedOrderKey}`);
  });

  it('says only whether a recipient block was bound, and never offers to reveal one', () => {
    const host = rendered(<Screen data={ready} />);
    const recipient = host.querySelector('[data-testid="recipient"]')!;
    expect(recipient.getAttribute('data-bound')).toBe('true');
    expect(recipient.textContent).toContain('The runner bound a complete recipient block to a fingerprint.');
    expect(recipient.textContent).toContain('Arcana holds fingerprints only.');
    expect(recipient.querySelectorAll('button, a')).toHaveLength(0);
    const unbound = rendered(<Screen data={{ view: 'ready', props: { ...ready.props, detail: { ...ready.props.detail, preflight: { ...passing, recipientBound: false } } } }} />);
    expect(unbound.querySelector('[data-testid="recipient"]')?.getAttribute('data-bound')).toBe('false');
  });

  it('has no control that acts: the one order button is disabled and says ordering is not built', () => {
    for (const data of [ready, heldAtStock, stale]) {
      const host = rendered(<Screen data={data} />);
      expect(host.querySelectorAll('button')).toHaveLength(1);
      expect(host.querySelectorAll('button:not([disabled])')).toHaveLength(0);
      expect(host.querySelector('[data-testid="place-order-note"]')?.textContent).toContain('Ordering is not built in this round.');
      expect(host.textContent).not.toMatch(/Yes, (place|order|send)/);
    }
  });

  it('names check seven, the fulfillable units and why an active listing is not fulfillable stock', () => {
    const host = rendered(<Screen data={heldAtStock} />);
    const banner = host.querySelector('[data-testid="preflight-held"]')!;
    expect(banner.getAttribute('data-check')).toBe('fulfillable_stock');
    expect(banner.textContent).toContain('1 of 8 checks do not hold.');
    expect(banner.textContent).not.toContain('not reached');
    const checks = rows(host);
    expect(checks).toHaveLength(8);
    // The runner runs all eight checks: check eight passed; only its read time was not recorded.
    expect(checks.filter((row) => row.getAttribute('data-outcome') === 'pass')).toHaveLength(7);
    expect(checks[7]!.getAttribute('data-outcome')).toBe('pass');
    expect(checks[7]!.querySelector('.wa-badge')?.textContent).toBe('holds');
    expect(checks[7]!.querySelector('[data-read="not-recorded"]')?.textContent).toBe('read time not recorded');
    expect(host.textContent).not.toContain('not reached');
    expect(host.querySelectorAll('.wa-badge--good')).toHaveLength(7);
    expect(checks[6]!.getAttribute('data-outcome')).toBe('hold');
    expect(checks[6]!.querySelector('[data-testid="check-reasons"]')?.textContent).toBe('selected_sku_not_mcf_fulfillable. ');
    expect(checks[6]!.textContent).toContain('channel MFN · MCF-fulfillable no');
    // A read of zero units is a read, and says 0; the missing read time of check eight says not recorded.
    expect(host.querySelector('[data-testid="held-units"]')?.textContent).toBe('0');
    expect(host.querySelectorAll('[data-read="not-recorded"]')).toHaveLength(1);
    expect(checks[7]!.textContent).toContain('none');
    expect(host.querySelector('[data-testid="listing-trap"]')?.textContent).toContain('An active listing is not fulfillable stock.');
    expect(host.querySelector('[data-testid="product-switch-link"]')?.getAttribute('href')).toBe(`/creators/samples/${held.derivedOrderKey}/product-switch`);
    expect(host.querySelector('[data-testid="what-this-will-do"]')).toBeNull();
    expect(checks[5]!.textContent).toContain('fee not recorded; cap 8.00');
    expect(host.querySelector('[data-testid="preview"]')?.textContent).toBe('No fulfillment preview is recorded with this run.');
  });

  it('never renders a missing stock read as zero units', () => {
    const host = rendered(<Screen data={{ view: 'ready', props: { ...heldAtStock.props, detail: { ...heldAtStock.props.detail,
      preflight: { ...held, inventory: null } } } }} />);
    expect(host.querySelector('[data-testid="held-units"]')?.textContent).toBe('not read');
    expect(rows(host)[6]!.textContent).toContain('Fulfillable units: not read');
    expect(host.querySelector('[data-testid="listing-trap"]')).toBeNull();
    expect(merchantFulfilled(null)).toBe(false);
    expect(merchantFulfilled({ ...held.inventory!, fulfillmentChannel: 'AFN', mcfFulfillable: true })).toBe(false);
    expect(merchantFulfilled({ ...held.inventory!, fulfillmentChannel: 'AFN', mcfFulfillable: false })).toBe(true);
  });

  it('treats a pass whose preview expired as stale, with the read time and the window it was judged by', () => {
    const host = rendered(<Screen data={stale} />);
    const banner = host.querySelector('[data-testid="preflight-stale"]')!;
    expect(banner.textContent).toContain('06:33:17');
    expect(banner.textContent).toContain('30 minutes after the read, since the runner recorded no expiry');
    expect(banner.textContent).toContain('a new pre-flight is needed before any order');
    expect(host.querySelector('[data-testid="what-this-will-do"] h2')?.textContent).toBe('What this would have done');
    expect(host.querySelector('[data-testid="preflight-provenance"]')?.textContent).toContain('2 earlier runs are recorded for this lane');
    expect(previewValidity(passing.preview!).until).toBe('2026-09-09T07:03:17.000Z');
    expect(previewValidity({ ...passing.preview!, validUntil: '2026-09-09T06:35:00.000Z' })).toEqual({ until: '2026-09-09T06:35:00.000Z',
      basis: 'the expiry the runner recorded' });
    // The runner's own expiry wins over the window: expired at six minutes.
    const early = rendered(<Screen data={{ view: 'ready', props: { now: NOW, detail: { ...ready.props.detail,
      preflight: { ...passing, preview: { ...passing.preview!, validUntil: '2026-09-09T06:35:00.000Z' } } } } }} />);
    expect(early.querySelector('[data-testid="preflight-stale"]')).not.toBeNull();
    expect(rendered(<Screen data={ready} />).querySelector('[data-testid="preflight-stale"]')).toBeNull();
  });

  it('accepts only a derived order key from the path', () => {
    expect(sampleOrderKeyParam(passing.derivedOrderKey)).toBe(passing.derivedOrderKey);
    for (const value of [undefined, '', 'CCS-ABC', passing.derivedOrderKey.toUpperCase(), '00000000-0000-4000-8000-000000000276', `${passing.derivedOrderKey}0`]) {
      expect(sampleOrderKeyParam(value)).toBeNull();
    }
    for (const data of [ready, heldAtStock, notMeasured, nothingHeld]) expect(CreatorSampleOrderKey.safeParse(data.props.detail.derivedOrderKey).success).toBe(true);
  });

  it('keeps a held run held when its preview expired, and never calls it a pass that no longer stands', () => {
    const host = rendered(<Screen data={{ view: 'ready', props: { now: '2026-09-09T07:30:00.000Z', detail: { ...heldAtStock.props.detail,
      preflight: { ...held, preview: passing.preview } } } }} />);
    expect(host.querySelector('[data-testid="preflight-stale"]')).toBeNull();
    expect(host.querySelector('[data-creator-state="stale"]')).toBeNull();
    expect(host.querySelector('[data-testid="preflight-held"]')).not.toBeNull();
    const note = host.querySelector('[data-testid="preflight-hold-preview-expired"]')!;
    expect(note.textContent).toContain('The preview this hold was judged with has expired.');
    expect(note.textContent).toContain('A new pre-flight is needed before this lane can pass.');
    expect(host.textContent).not.toContain('nothing was sent');
    expect(host.textContent).not.toContain('this pass no longer stands');
  });

  it('shows a check\'s outcome whatever its read time, because the runner never stops early', () => {
    const unread = { ...passing.checks[7]!, readAt: null };
    expect(checkState(unread, { result: 'HOLD' })).toBe('pass');
    expect(checkState(unread, { result: 'PASS' })).toBe('pass');
    expect(checkState(passing.checks[7]!, { result: 'HOLD' })).toBe('pass');
    expect(checkState({ ...unread, outcome: 'hold', reasons: ['page_validation_error'] }, { result: 'HOLD' })).toBe('hold');
  });
});
