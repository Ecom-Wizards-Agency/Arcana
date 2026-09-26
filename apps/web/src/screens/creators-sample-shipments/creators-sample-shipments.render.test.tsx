// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import Loading from '../../../app/creators/samples/loading';
import SharedError from '../../../app/creators/samples/error';
import { rendered } from '../render-test-support';
import { verifyScreen } from '../settings/render-support';
import { descriptor } from './descriptor';
import { ambiguous, empty, notImported, queueOnly, ready, refused, shipped } from './render-fixture';
import Screen, { carrierHasNoScan } from './view';

verifyScreen(descriptor, [
  { state: 'loading', name: 'renders the route loading boundary', render: () => <Loading />, text: '' },
  { state: 'error', name: 'renders the shared error boundary with its reference', render: () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-reference' })} reset={() => { }} />, text: 'synthetic-reference' },
  { state: 'error', name: 'preserves the safe read error message', render: () => <Screen data={{ view: 'error', props: { message: 'Synthetic read unavailable' } }} />, text: 'Synthetic read unavailable' },
  { state: 'ready', name: 'says Amazon has the package and the carrier does not', render: () => <Screen data={ready} />, text: 'Amazon has the package, the carrier does not.' },
  { state: 'refused', name: 'refuses when the last read failed', render: () => <Screen data={refused} />, text: 'Nothing was read', absent: ['[data-testid="sample-lane"]'] },
  { state: 'empty', name: 'says no lane was recorded after the registry was read', render: () => <Screen data={empty} />, text: 'The runner has reserved, confirmed or cancelled no sample.' },
  { state: 'not-measured', name: 'says nothing was imported rather than no samples', render: () => <Screen data={notImported} />, text: 'Nothing imported yet', absent: ['[data-creator-state="no-samples"]'] },
  { state: 'not-measured', name: 'does not read an import without the registry or reservation list as no samples', render: () => <Screen data={queueOnly} />, text: 'read no registry cache or MCF reservation list', absent: ['[data-creator-state="no-samples"]'] },
  { state: 'gated', name: 'keeps viewers out', render: () => <Screen data={{ view: 'gated', props: {} }} />, text: 'Owners, admins and analysts only' },
]);

describe('sample shipments', () => {
  it('draws each lane with its derived key, lane state, fee and Amazon provenance per value', () => {
    const host = rendered(<Screen data={ready} />);
    expect(host.querySelectorAll('[data-testid="sample-lane"]')).toHaveLength(2);
    expect([...host.querySelectorAll('[data-testid="order-key"]')].map((key) => key.textContent)).toEqual([shipped.derivedOrderKey, ambiguous.derivedOrderKey]);
    const lane = (record: string) => [...host.querySelectorAll('[data-testid="sample-lane"]')].find((row) => row.textContent?.includes(record))!;
    expect(lane('CCR-SW-26-0088').textContent).toContain('Amazon · getFulfillmentOrder · 11:02:41');
    expect(lane('CCR-SW-26-0088').textContent).toContain('The carrier has no scan for it yet');
    expect(lane('CCR-SW-26-0088').textContent).toContain('6.20');
    expect(lane('CCR-SW-26-0072').textContent).toContain('Reconciliation Required');
    expect(lane('CCR-SW-26-0072').textContent).toContain('MCFR-9f2c41ab77e0d3b5');
    expect(lane('CCR-SW-26-0072').textContent?.match(/Not read from Amazon/g)).toHaveLength(2);
    expect(host.querySelector('[data-testid="carrier-no-scan"]')?.textContent).toContain('1 sample has a tracking number with no carrier scan');
    expect(host.querySelector('[data-testid="reconciliation-required"]')?.textContent).toContain('A corrective second order is never placed.');
    expect(host.querySelector('[data-status="run-by-hand"]')?.textContent).toBe('Run by hand');
  });

  it('only calls it a carrier gap when Amazon was read and the package has tracking but no scan', () => {
    expect(carrierHasNoScan(shipped)).toBe(true);
    expect(carrierHasNoScan(ambiguous)).toBe(false);
    expect(carrierHasNoScan({ ...shipped, packages: [{ ...shipped.packages![0]!, carrierStatus: 'IN_TRANSIT', carrierStatusReadAt: '2026-09-10T08:00:00.000Z' }] })).toBe(false);
    expect(carrierHasNoScan({ ...shipped, mcf: { ...shipped.mcf!, status: 'Planning' } })).toBe(false);
    const scanned = rendered(<Screen data={{ view: 'ready', props: { snapshot: { ...ready.props.snapshot, shipments: [{ ...shipped,
      packages: [{ ...shipped.packages![0]!, carrierStatus: 'IN_TRANSIT', carrierStatusReadAt: '2026-09-10T08:00:00.000Z' }] }] } } }} />);
    expect(scanned.querySelector('[data-testid="carrier-no-scan"]')).toBeNull();
    expect(scanned.textContent).toContain('IN_TRANSIT · Amazon · getPackageTrackingDetails · 08:00:00');
  });
});
