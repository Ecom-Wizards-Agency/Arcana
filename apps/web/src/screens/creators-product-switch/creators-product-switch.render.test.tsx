// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import Loading from '../../../app/creators/samples/[id]/product-switch/loading';
import SharedError from '../../../app/creators/samples/[id]/product-switch/error';
import { rendered } from '../render-test-support';
import { verifyScreen } from '../settings/render-support';
import { formatTimestamp } from '../../ui/date-format';
import { sampleOrderKeyParam } from '../creators-sample-preflight/order-key';
import { descriptor } from './descriptor';
import { KEY, OFFERED, ORIGINAL, RECORD, detail, empty, missing, notMeasured, ready, refused, withoutOriginalPreflight } from './render-fixture';
import Screen, { disposition } from './view';

verifyScreen(descriptor, [
  { state: 'loading', name: 'renders the route loading boundary', render: () => <Loading />, text: '' },
  { state: 'error', name: 'renders the shared error boundary with its reference', render: () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-reference' })} reset={() => { }} />, text: 'synthetic-reference' },
  { state: 'error', name: 'preserves the safe read error message', render: () => <Screen data={{ view: 'error', props: { message: 'Synthetic read unavailable' } }} />, text: 'Synthetic read unavailable' },
  { state: 'ready', name: 'draws why the original cannot ship and every alternate checked in live stock (447:219)', render: () => <Screen data={ready} />, text: 'Every candidate was checked in live stock' },
  { state: 'refused', name: 'withholds the blocker and the alternates when the last read failed', render: () => <Screen data={refused} />, text: 'Nothing was read',
    absent: ['[data-testid="switch-candidate"]', '[data-testid="why-original"]', '[data-testid="queue-item"]', 'button'] },
  { state: 'empty', name: 'says nothing Arcana holds carries the key', render: () => <Screen data={empty} />, text: 'carries the order key CCS-00000000000000000000000000000abc' },
  { state: 'empty', name: 'says a malformed address names no sample order key', render: () => <Screen data={missing} />, text: 'This address does not name a sample order key.' },
  { state: 'not-measured', name: 'says no switch pre-flight is recorded, never that there are no alternates', render: () => <Screen data={notMeasured} />,
    text: 'No product-switch pre-flight is recorded for this lane', absent: ['[data-testid="switch-candidate"]', 'button'] },
  { state: 'gated', name: 'keeps viewers out', render: () => <Screen data={{ view: 'gated', props: {} }} />, text: 'Owners, admins and analysts only' },
]);

describe('product switch', () => {
  it('heads the page with the record, status, phase and queue row, and names no person', () => {
    const host = rendered(<Screen data={ready} />);
    expect(host.querySelector('[data-status="run-by-hand"]')?.textContent).toBe('Run by hand');
    expect(host.querySelector('h1')?.textContent).toContain('Product switch');
    const subtitle = host.querySelector('.wa-page-head .wa-page-sub')!.textContent!;
    expect(subtitle).toContain(`${RECORD} · Product Switch Pending · Unlocked · phase offer · Last read`);
    expect(host.querySelector('[data-testid="order-key"]')?.textContent).toBe(KEY);
    const queue = host.querySelector('[data-testid="queue-item"]')!;
    expect(queue.getAttribute('data-action')).toBe('SEND_PRODUCT_SWITCH_FOLLOW_UP');
    expect(queue.textContent).toMatch(/^Product-switch follow-up · PENDING_APPROVAL · due 10 Sept? 2026$/);
    // No greeting and no message body: Arcana holds no name and no message text.
    expect(host.textContent).not.toMatch(/\bHi\b|\bHello\b|Dear /);
    expect(host.querySelector('[data-testid="active-asin-banner"]')?.textContent).toContain(`${ORIGINAL} stays the active ASIN on this record.`);
    expect(host.querySelector('[data-testid="active-asin-banner"]')?.textContent).toContain('a generic acknowledgement is not a confirmation');
  });

  it('says why the original cannot ship from its pre-flight: the stock check, its code and the stock read', () => {
    const host = rendered(<Screen data={ready} />);
    const source = host.querySelector('[data-testid="original-source"]')!;
    expect(source.getAttribute('data-source')).toBe('preflight');
    const check = host.querySelector('[data-testid="original-stock-check"]')!;
    expect(check.getAttribute('data-outcome')).toBe('hold');
    expect([...check.querySelectorAll('[data-code]')].map((code) => code.textContent)).toEqual(['selected_sku_not_mcf_fulfillable']);
    const inventory = host.querySelector('[data-testid="original-inventory"]')!;
    expect([...inventory.querySelectorAll('dt')].map((term) => term.textContent)).toEqual(['ASIN', 'SKU', 'Channel', 'MCF-fulfillable', 'Fulfillable units', 'Checked']);
    expect([...inventory.querySelectorAll('dd')].map((value) => value.textContent)).toEqual([
      ORIGINAL, 'SW-DERMA-03-FBM', 'merchant-fulfilled', 'no', '0 units', `${formatTimestamp('2026-09-09T06:36:00.000Z')} · ev:mcf-inv-17`]);
    // A read of zero is a zero; it came from an inventory read.
    expect(host.querySelector('[data-testid="original-units"] [data-units]')?.getAttribute('data-units')).toBe('0');
  });

  it('draws one row per alternate, offered first, a hold labelled apart from a disagreement, with every code', () => {
    const host = rendered(<Screen data={ready} />);
    const rows = [...host.querySelectorAll('[data-testid="switch-candidate"]')];
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => [row.getAttribute('data-asin'), row.getAttribute('data-disposition'), row.getAttribute('data-outcome')])).toEqual([
      [OFFERED, 'offered', 'pass'], ['B0D6H9YY41', 'held', 'hold'], ['B0DB4X2NRT', 'disagreement', 'fail']]);
    expect(rows.filter((row) => row.getAttribute('data-disposition') === 'offered')).toHaveLength(1);
    expect(rows.filter((row) => row.getAttribute('data-disposition') !== 'offered')).toHaveLength(2);
    expect(rows.map((row) => row.querySelector('.wa-badge')?.textContent)).toEqual(['offered', 'excluded: held', 'excluded: sources disagree']);
    expect(rows.map((row) => [...row.querySelectorAll('[data-code]')].map((code) => code.textContent))).toEqual([
      [], ['selected_sku_not_fba_fulfilled', 'selected_sku_not_mcf_fulfillable', 'insufficient_mcf_fulfillable_quantity'],
      ['alternate_asin_not_in_campaign', 'alternate_catalog_asin_mismatch']]);
    expect(rows.map((row) => row.querySelector('[data-units]')?.getAttribute('data-units'))).toEqual(['37', '0', '88']);
    expect(rows[0]!.textContent).toContain('SW-DERMA-05-FBA');
    expect(rows[0]!.textContent).toContain('Amazon-fulfilled');
    expect(rows[0]!.textContent).toContain('13:40 UTC');
    expect(rows.every((row) => row.textContent!.includes('offer'))).toBe(true);
    expect(host.querySelector('[data-testid="switch-candidates"] h2')?.textContent).toBe('Every candidate was checked in live stock 3 checked · 1 offered · 2 excluded');
    expect(host.querySelector('[data-testid="none-offered"]')).toBeNull();
    expect(detail.alternates.map(disposition)).toEqual(['offered', 'held', 'disagreement']);
  });

  it('asks for a reply naming the offered ASIN and treats an acknowledgement as nothing', () => {
    const host = rendered(<Screen data={ready} />);
    const panel = host.querySelector('[data-testid="acknowledgement"]')!;
    expect(panel.querySelector('[data-quote="counts"]')?.textContent).toBe(`“Yes, ${OFFERED} works for me.”`);
    expect([...panel.querySelectorAll('[data-quote="does-not-count"]')].map((quote) => quote.textContent))
      .toEqual(['“Sure, sounds good.”', '“Ok!”', '“Whatever you have is fine.”']);
    expect(panel.textContent).toContain('a switch does not inherit the original\'s passes');
    expect(panel.textContent).toContain('the ten checks are recomputed and the full pre-flight runs again');
  });

  it('offers exactly one control, disabled, with its reason, and links back without acting', () => {
    const host = rendered(<Screen data={ready} />);
    expect(host.querySelectorAll('button')).toHaveLength(1);
    expect(host.querySelectorAll('button:not([disabled])')).toHaveLength(0);
    expect(host.querySelector('button')?.textContent).toBe('Confirm the switch');
    expect(host.querySelector('#confirm-switch-reason')?.textContent).toContain(`it would need a reply naming ${OFFERED} on the record first`);
    expect(host.querySelector('[data-testid="nothing-sent"]')?.textContent).toBe('Nothing was ordered, reserved or sent from Arcana.');
    expect(host.querySelectorAll('form')).toHaveLength(0);
    expect([...host.querySelectorAll('[data-testid="switch-links"] a')].map((link) => link.getAttribute('href')))
      .toEqual(['/creators/samples', `/creators/records/${RECORD}`, `/creators/samples/${KEY}/preflight`]);
  });

  it('takes the reason from the switch pre-flights when the original has none, and never draws an unread count as 0', () => {
    const host = rendered(<Screen data={withoutOriginalPreflight} />);
    const source = host.querySelector('[data-testid="original-source"]')!;
    expect(source.getAttribute('data-source')).toBe('switch-preflight');
    expect(source.querySelector('[data-reason]')?.getAttribute('data-reason')).toBe('not_mcf_fulfillable');
    expect(source.textContent).toContain('The original SKU is not MCF-fulfillable');
    expect(source.textContent).toContain('ev:mcf-inv-17');
    const rows = [...host.querySelectorAll('[data-testid="switch-candidate"]')];
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.querySelector('[data-units]')?.getAttribute('data-units'))).toEqual(['37', 'not-read', '88']);
    expect(rows[1]!.querySelector('[data-units]')?.textContent).toBe('not read');
    expect(rows[1]!.querySelectorAll('[data-time="not-read"]')).toHaveLength(1);
    expect(rows[1]!.textContent).not.toContain('0 units');
    expect(host.querySelector('[data-testid="switch-status"]')?.textContent).toBe('status not reported');
    expect(host.querySelector('[data-testid="queue-none"]')?.textContent).toBe('The newest queue run did not name this record.');
    expect(host.querySelectorAll('[data-testid="queue-item"]')).toHaveLength(0);
  });

  it('says the reason is not recorded when neither source names one, and when nothing is offered says so', () => {
    const bare = { ...withoutOriginalPreflight.props.detail, alternates: withoutOriginalPreflight.props.detail.alternates.slice(1)
      .map((alternate) => ({ ...alternate, originalUnavailableReason: null, originalBlockerEvidenceReference: null })) };
    const host = rendered(<Screen data={{ view: 'ready', props: { detail: bare } }} />);
    expect(host.querySelector('[data-testid="original-source"]')?.getAttribute('data-source')).toBe('not-recorded');
    expect(host.querySelector('[data-testid="original-source"]')?.textContent).toContain('The reason the original cannot ship is not recorded');
    expect(host.querySelectorAll('[data-testid="switch-candidate"][data-disposition="offered"]')).toHaveLength(0);
    expect(host.querySelectorAll('[data-testid="switch-candidate"]')).toHaveLength(2);
    expect(host.querySelector('[data-testid="none-offered"]')?.textContent).toContain('No alternate cleared every check');
    expect(host.querySelector('[data-quote="counts"]')?.textContent).toBe('“Yes, [the alternate ASIN] works for me.”');
    expect(host.querySelectorAll('button:not([disabled])')).toHaveLength(0);
  });

  it('keeps the original blocker but no candidates when no switch pre-flight ran', () => {
    const host = rendered(<Screen data={notMeasured} />);
    expect(host.querySelector('[data-creator-state="switch-not-measured"]')?.textContent).toContain('It is not the same as no alternates.');
    expect(host.querySelectorAll('[data-testid="why-original"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-testid="switch-candidate"]')).toHaveLength(0);
    expect(host.querySelectorAll('[data-testid="acknowledgement"]')).toHaveLength(0);
    expect(host.textContent).not.toContain('No alternates');
  });

  it('refuses without drawing a queue row, a blocker or a control', () => {
    const host = rendered(<Screen data={refused} />);
    expect(host.querySelectorAll('[data-creator-state="refused"]')).toHaveLength(1);
    expect(host.querySelector('[data-testid="creator-product-switch"]')?.getAttribute('data-switch-state')).toBe('refused');
    expect(host.querySelectorAll('[data-testid="switch-candidate"]')).toHaveLength(0);
    expect(host.querySelectorAll('button')).toHaveLength(0);
  });

  it('accepts only a derived order key from the path', () => {
    expect(sampleOrderKeyParam(KEY)).toBe(KEY);
    for (const value of [undefined, '', KEY.toUpperCase(), KEY.slice(0, -1), `${KEY}0`, 'CCR-SW-26-0166']) expect(sampleOrderKeyParam(value)).toBeNull();
  });

  it('heads the page with the newest switch pre-flight\'s phase, not the offered one\'s', () => {
    const [first, ...rest] = detail.alternates;
    const confirmRun = { ...rest[rest.length - 1]!, phase: 'confirm', completedAt: '2026-09-10T09:00:00.000Z' };
    const host = rendered(<Screen data={{ view: 'ready', props: { detail: { ...detail, alternates: [first!, ...rest.slice(0, -1), confirmRun] } } }} />);
    expect(detail.alternates.length).toBeGreaterThan(1);
    expect(host.textContent?.match(/phase confirm/g)).toHaveLength(1);
  });
});
