// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import Loading from '../../../app/creators/samples/loading';
import SharedError from '../../../app/creators/samples/error';
import { rendered } from '../render-test-support';
import { verifyScreen } from '../settings/render-support';
import { descriptor } from './descriptor';
import { snapshot as queue } from '../creators-daily-queue/render-fixture';
import { dailyReport } from './daily-report';
import { SAMPLES_NOW, ambiguous, empty, notImported, queueOnly, ready, refused, reported, shipped } from './render-fixture';
import { GATE_OFF, GATE_ON, KEY, SEND, arrived, reservedLane } from '../creators-sample-preflight/render-fixture';
import type { SamplesSending } from './load';
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
      packages: [{ ...shipped.packages![0]!, carrierStatus: 'IN_TRANSIT', carrierStatusReadAt: '2026-09-10T08:00:00.000Z' }] }] }, report: null, sending: null,
      now: SAMPLES_NOW } }} />);
    expect(scanned.querySelector('[data-testid="carrier-no-scan"]')).toBeNull();
    expect(scanned.textContent).toContain('IN_TRANSIT · Amazon · getPackageTrackingDetails · 08:00:00');
  });

  it('links every lane to its pre-flight, order and product switch by the derived key', () => {
    const host = rendered(<Screen data={ready} />);
    const links = [...host.querySelectorAll('[data-testid="lane-links"] a')].map((link) => link.getAttribute('href'));
    expect(links).toHaveLength(6);
    expect(links).toEqual([shipped, ambiguous].flatMap((lane) => [`/creators/samples/${lane.derivedOrderKey}/preflight`,
      `/creators/samples/fulfillment/${lane.derivedOrderKey}`, `/creators/samples/${lane.derivedOrderKey}/product-switch`]));
    expect(host.querySelector('[data-testid="daily-report-link"]')?.getAttribute('href')).toBe('/creators/samples?report=daily');
    expect(host.querySelector('[data-testid="daily-report"]')).toBeNull();
  });
});

describe('daily report', () => {
  it('renders the text that would be posted, says nothing is posted, and counts what it withheld', () => {
    const host = rendered(<Screen data={reported} />);
    const modal = host.querySelector('[data-testid="daily-report"] [role="dialog"]')!;
    expect(modal.getAttribute('aria-labelledby')).toBe('daily-report-title');
    expect(modal.querySelector('#daily-report-title')?.textContent).toBe('Daily report');
    // The screen behind it is inert; the report is not.
    expect(host.querySelectorAll('[inert]')).toHaveLength(1);
    expect(host.querySelector('[inert] [data-testid="creator-samples"]')).not.toBeNull();
    expect(host.querySelector('[inert] [data-testid="daily-report"]')).toBeNull();
    expect(rendered(<Screen data={ready} />).querySelectorAll('[inert]')).toHaveLength(0);
    expect(modal.querySelector('[data-testid="daily-report-nothing-posted"]')?.textContent).toContain('Nothing is posted from Arcana.');
    const gate = (value: string) => queue.items.filter((item) => item.gateResult === value).length;
    const lines = modal.querySelector('[data-testid="daily-report-text"]')!.textContent!.split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^Creator Connections daily report · 9 Sept? 2026$/);
    expect(queue.items).toHaveLength(34);
    expect(lines[1]).toContain(`34 items (${gate('BLOCKED')} blocked, ${gate('HOLD')} on hold, ${gate('PENDING_APPROVAL')} awaiting approval)`);
    expect(lines[2]).toContain('412 threads enumerated, 37 changed, 9 held or escalated, 7 unmatched; it did not reconcile.');
    expect(lines[3]).toBe('Sample lanes: 2 (1 Reconciliation Required, 1 Confirmed).');
    expect(lines[4]).toBe('Amazon order reads: 1 found, 1 not found yet.');
    const removed = [...modal.querySelectorAll('[data-testid="daily-report-removed"] li')].map((item) => item.textContent);
    expect(removed).toHaveLength(3);
    expect(removed[0]).toContain('Tracking numbers: 1 withheld');
    expect(removed[1]).toContain('Runner order ids: 1 withheld');
    expect(removed[2]).toContain('Arcana holds none of these');
    // Nothing withheld reaches the text.
    for (const value of ['SYNTHETIC-TRACK-0088', 'synthetic-order-0088', 'CCR-SW-26-0088', shipped.derivedOrderKey]) {
      expect(modal.querySelector('[data-testid="daily-report-text"]')?.textContent).not.toContain(value);
    }
    expect(modal.querySelector('a[data-testid="daily-report-close"]')?.getAttribute('href')).toBe('/creators/samples');
    expect(modal.querySelectorAll('button, form')).toHaveLength(0);
  });

  it('says what it could not measure rather than reporting zero', () => {
    const none = dailyReport(notImported.props.snapshot, { queue: { ...queue, runDate: null, items: [], sweep: null, lastImport: null }, settlements: {} });
    expect(none.lines.slice(1)).toEqual(['Queue: not measured, because no queue file has been read.',
      'Inbox sweep: not measured, because none came with the last import.',
      'Sample lanes: not measured, because no registry or reservation list has been read.']);
    expect(none.removed.map((entry) => entry.count)).toEqual([0, 0, null]);
    const unread = dailyReport(ready.props.snapshot, { queue, settlements: {} });
    expect(unread.lines[4]).toBe('Amazon order reads: 2 not read yet.');
    const failed = dailyReport(refused.props.snapshot, { queue, settlements: {} });
    expect(failed.lines).toHaveLength(2);
    expect(failed.lines[1]).toContain('failed, so nothing here would read as current.');
    expect(dailyReport(empty.props.snapshot, { queue, settlements: {} }).lines[3]).toBe('Sample lanes: none recorded.');
  });
});

describe('Arcana sending on the list (WP-338g)', () => {
  const second = { ...reservedLane, creatorRecordId: 'CCR-SW-26-0091', derivedOrderKey: 'CCS-91a0f3c9e1b7d42a8c6e0f1b3d5a7c9e' };
  const third = { ...reservedLane, creatorRecordId: 'CCR-SW-26-0093', derivedOrderKey: 'CCS-93a0f3c9e1b7d42a8c6e0f1b3d5a7c9e', laneState: 'Reconciliation Required' as const,
    orderOwner: 'arcana' as const, reconciliationReason: 'outcome_unknown' as const };
  const fourth = { ...reservedLane, creatorRecordId: 'CCR-SW-26-0094', derivedOrderKey: 'CCS-94a0f3c9e1b7d42a8c6e0f1b3d5a7c9e', laneState: 'Verified for Submit' as const,
    orderOwner: 'arcana' as const };
  const fifth = { ...reservedLane, creatorRecordId: 'CCR-SW-26-0095', derivedOrderKey: 'CCS-95a0f3c9e1b7d42a8c6e0f1b3d5a7c9e', laneState: 'Verified for Submit' as const,
    orderOwner: 'arcana' as const };
  const sixth = { ...reservedLane, creatorRecordId: 'CCR-SW-26-0096', derivedOrderKey: 'CCS-96a0f3c9e1b7d42a8c6e0f1b3d5a7c9e' };
  const sending: SamplesSending = {
    gate: GATE_ON, key: KEY, escalated: [third.derivedOrderKey],
    sends: {
      [reservedLane.derivedOrderKey]: { ...SEND, latestPreview: { ...SEND.latestPreview!, readAt: '2026-09-09T10:53:00.000Z' } },
      [second.derivedOrderKey]: null,
      [sixth.derivedOrderKey]: 'unread',
      [third.derivedOrderKey]: { ...SEND, state: 'uncertain', custodyExpiresAt: null, latestPreview: null },
      [fourth.derivedOrderKey]: { ...SEND, state: 'conflict', custodyExpiresAt: null, amazonStatus: 'Planning', events: arrived('conflict', ['sku_mismatch']) },
      [fifth.derivedOrderKey]: { ...SEND, state: 'accepted', escalationReason: 'ladder_exhausted', custodyExpiresAt: null, amazonStatus: null },
    },
  };
  const data = (value: SamplesSending) => ({ view: 'ready' as const, props: { snapshot: { ...ready.props.snapshot,
    shipments: [shipped, reservedLane, second, third, fourth, fifth, sixth] }, report: null, sending: value, now: SAMPLES_NOW } });

  it('heads the list with units approved today (UTC) against the cap and whether sending is on', () => {
    const host = rendered(<Screen data={data(sending)} />);
    expect(host.querySelector('[data-testid="sending-header"]')?.getAttribute('data-sending')).toBe('on');
    expect(host.querySelector('[data-testid="units-today"]')?.textContent).toBe('Units approved today (UTC): 2 of 5');
    const off = rendered(<Screen data={data({ ...sending, gate: GATE_OFF, key: { status: 'absent' } })} />);
    expect(off.querySelector('[data-testid="sending-header"]')?.getAttribute('data-sending')).toBe('off');
    expect([...off.querySelectorAll('[data-testid="sending-header"] [data-missing]')].map((item) => item.getAttribute('data-missing')))
      .toEqual(['grant', 'heartbeat', 'key_absent']);
    expect(off.querySelector('[data-testid="units-today"]')?.textContent).toBe('Units approved today (UTC): not measured without a grant');
  });

  it('adds address, preview age, send state and Amazon status per lane', () => {
    const host = rendered(<Screen data={data(sending)} />);
    const rows = [...host.querySelectorAll('[data-testid="sample-lane"]')];
    expect(rows).toHaveLength(7);
    expect(rows[6]!.querySelector('[data-testid="send-cells"]')?.textContent).toBe('Send not read: the ledger read failed');
    expect(host.querySelectorAll('thead th')).toHaveLength(12);
    expect(rows[0]!.querySelector('[data-testid="send-cells"]')?.textContent).toBe('Runner lane; no Arcana send');
    expect(rows[1]!.querySelector('[data-testid="send-address"]')?.textContent).toBe('Sealed · US · 94••• · 2 linesexpires 08:35 UTC');
    expect(rows[1]!.querySelector('[data-testid="send-preview-age"]')?.textContent).toBe('12 min');
    expect(rows[1]!.querySelector('[data-testid="send-state"]')?.getAttribute('data-send-state')).toBe('preview_ready');
    expect(rows[1]!.querySelector('[data-testid="send-amazon"]')?.textContent).toBe('not read');
    expect(rows[2]!.querySelector('[data-testid="send-cells"]')?.textContent).toBe('Ready for address');
    expect(rows[3]!.querySelector('[data-testid="send-preview-age"]')?.textContent).toBe('no preview');
    expect(rows[4]!.querySelector('[data-testid="send-amazon"]')?.textContent).toBe('Planning');
  });

  it('counts the sends that need a person in banners', () => {
    const host = rendered(<Screen data={data(sending)} />);
    for (const testid of ['send-uncertain', 'send-escalated', 'send-conflict', 'send-ladder']) {
      expect(host.querySelector(`[data-testid="${testid}"]`)?.getAttribute('data-count')).toBe('1');
    }
    const calm = rendered(<Screen data={data({ ...sending, escalated: [], sends: { [reservedLane.derivedOrderKey]: SEND } })} />);
    expect(calm.querySelectorAll('[data-testid^="send-"][data-count]')).toHaveLength(0);
  });

  it('shows no sending header or send columns when the list is withheld', () => {
    const host = rendered(<Screen data={{ ...refused, props: { ...refused.props, sending } }} />);
    expect(host.querySelector('[data-testid="sending-header"]')).toBeNull();
  });
});
