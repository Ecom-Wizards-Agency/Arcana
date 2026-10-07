import type { CreatorSampleShipment, CreatorSampleSnapshot } from '@wizard-ads/shared';
import { Badge, EmptyState, TableFrame } from '../../ui/primitives';
import { formatTimestamp } from '../../ui/date-format';
import { CreatorGated, CreatorHeader, CreatorLoadError, ImportRefusal, NotImported, count, lastRead } from '../creators-daily-queue/creator-frame';
import { DailyReportModal, dailyReport, type DailyReportData } from './daily-report';
import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;

const LANE_TONE = { Reserved: 'info', 'Verified for Submit': 'info', 'Reconciliation Required': 'bad', Confirmed: 'good', Cancelled: 'neutral' } as const;
const clock = (value: string) => new Date(value).toISOString().slice(11, 19);
/** Provenance per value: which Amazon operation said it, and when. */
const amazon = (operation: string, readAt: string) => `Amazon · ${operation} · ${clock(readAt)}`;
const money = (cents: number | null) => cents === null ? 'Not recorded' : (cents / 100).toFixed(2);

/** Amazon holds a package with a tracking number, and the carrier has no scan for it yet. */
export function carrierHasNoScan(shipment: CreatorSampleShipment): boolean {
  return shipment.mcf !== null && ['Processing', 'Complete', 'CompletePartialled'].includes(shipment.mcf.status)
    && (shipment.packages ?? []).some((item) => item.trackingNumber !== null && item.carrierStatus === null);
}

function AmazonCell({ shipment }: { shipment: CreatorSampleShipment }) {
  if (shipment.mcf === null) return <span className="wa-page-sub">Not read from Amazon</span>;
  return <span data-provenance={shipment.mcf.operation}><strong>{shipment.mcf.status}</strong>
    <br /><span className="wa-page-sub">{amazon(shipment.mcf.operation, shipment.mcf.readAt)}</span></span>;
}

function PackagesCell({ shipment }: { shipment: CreatorSampleShipment }) {
  if (shipment.packages === null) return <span className="wa-page-sub">Not read from Amazon</span>;
  if (shipment.packages.length === 0) return <span>Amazon lists no package yet</span>;
  return <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{shipment.packages.map((item) => <li key={item.packageNumber} data-testid="sample-package">
    Package {item.packageNumber}: {item.carrierCode ?? 'carrier not named'} {item.trackingNumber ? <code>{item.trackingNumber}</code> : 'no tracking number'}
    <br /><span className="wa-page-sub">{item.carrierStatus === null
      ? 'The carrier has no scan for it yet'
      : `${item.carrierStatus}${item.carrierStatusReadAt ? ` · ${amazon('getPackageTrackingDetails', item.carrierStatusReadAt)}` : ''}`}</span></li>)}</ul>;
}

function LaneRow({ shipment }: { shipment: CreatorSampleShipment }) {
  const when = shipment.confirmedAt ?? shipment.cancelledAt ?? shipment.verifiedAt ?? shipment.reservedAt;
  return <tr data-testid="sample-lane" data-lane={shipment.laneState}>
    <td>{shipment.creatorRecordId}</td>
    <td><code>{shipment.asin}</code><br /><span className="wa-page-sub">{shipment.sku ?? 'SKU not recorded'}</span></td>
    <td><code data-testid="order-key" title="SHA-256 over organisation, creator record and ASIN; no date">{shipment.derivedOrderKey}</code></td>
    <td><Badge tone={LANE_TONE[shipment.laneState]}>{shipment.laneState}</Badge>
      {shipment.reservationId ? <><br /><span className="wa-page-sub">{shipment.reservationId}</span></> : null}
      {when ? <><br /><span className="wa-page-sub">Runner · {formatTimestamp(when)}</span></> : null}</td>
    <td className="wa-num" data-numeric="true">{money(shipment.feeCents)}{shipment.feeCapCents === null ? null : <><br /><span className="wa-page-sub">cap {money(shipment.feeCapCents)}</span></>}</td>
    <td><AmazonCell shipment={shipment} /></td>
    <td><PackagesCell shipment={shipment} /></td>
    <td data-testid="lane-links"><a href={`/creators/samples/${shipment.derivedOrderKey}/preflight`} data-lane-link="preflight">Pre-flight</a>
      <br /><a href={`/creators/samples/fulfillment/${shipment.derivedOrderKey}`} data-lane-link="fulfillment">Order and shipment</a>
      <br /><a href={`/creators/samples/${shipment.derivedOrderKey}/product-switch`} data-lane-link="product-switch">Product switch</a></td>
  </tr>;
}

/**
 * With `?report=daily` the report opens over the screen. The screen behind it is
 * inert, so focus and the accessibility tree stay in the report until Close.
 */
function ReadySamples({ snapshot, report }: { snapshot: CreatorSampleSnapshot; report: DailyReportData | null }) {
  if (report === null) return <Samples snapshot={snapshot} />;
  return <><div inert data-testid="behind-daily-report"><Samples snapshot={snapshot} /></div><DailyReportModal report={dailyReport(snapshot, report)} /></>;
}

function Samples({ snapshot }: { snapshot: CreatorSampleSnapshot }) {
  const { lastImport, shipments } = snapshot;
  const head = <CreatorHeader title="Sample shipments" subtitle={<>One sample per creator record and ASIN, keyed without a date · {lastRead(lastImport)}</>}>
    <a href="/creators/samples?report=daily" data-testid="daily-report-link">Daily report</a>
  </CreatorHeader>;
  if (lastImport?.status === 'failed') {
    return <main className="wa-stack" data-testid="creator-samples">{head}
      <ImportRefusal run={lastImport} withheld="The sample lanes are not shown, because they would read as current." /></main>;
  }
  if (lastImport === null || !lastImport.files.some((file) => file === 'registry' || file === 'mcf_reservations')) {
    return <main className="wa-stack" data-testid="creator-samples">{head}
      <NotImported what="the sample lanes" file="registry cache or MCF reservation list" run={lastImport} /></main>;
  }
  if (shipments.length === 0) {
    return <main className="wa-stack" data-testid="creator-samples">{head}
      <EmptyState variant="empty" data-creator-state="no-samples" title="No sample lanes"
        body="The runner has reserved, confirmed or cancelled no sample." meta={lastRead(lastImport)} /></main>;
  }
  const waiting = shipments.filter(carrierHasNoScan);
  const ambiguous = shipments.filter((item) => item.laneState === 'Reconciliation Required');
  return <main className="wa-stack" data-testid="creator-samples">
    {head}
    {waiting.length > 0 ? <section className="wa-banner wa-banner--warn" data-testid="carrier-no-scan" style={{ display: 'block' }}>
      <strong>Amazon has the package, the carrier does not.</strong>{' '}
      {count(waiting.length)} {waiting.length === 1 ? 'sample has' : 'samples have'} a tracking number with no carrier scan, so nothing has been sent
      to the creator yet: a confirmation goes out only once the carrier shows the parcel moving.
    </section> : null}
    {ambiguous.length > 0 ? <section className="wa-banner wa-banner--bad" data-testid="reconciliation-required" style={{ display: 'block' }}>
      <strong>{count(ambiguous.length)} {ambiguous.length === 1 ? 'submit was' : 'submits were'} ambiguous.</strong>{' '}
      The reservation stays locked and nothing more is ordered until Amazon order history shows whether the order exists.
      A corrective second order is never placed.
    </section> : null}
    <TableFrame><table className="wa-table">
      <thead><tr><th>Record</th><th>ASIN</th><th>Order key</th><th>Lane</th><th className="wa-num" data-numeric="true">Fee</th><th>MCF status</th><th>Packages</th><th>Open</th></tr></thead>
      <tbody>{shipments.map((shipment) => <LaneRow key={shipment.derivedOrderKey} shipment={shipment} />)}</tbody>
    </table></TableFrame>
    <p className="wa-page-sub">Fees are as the runner recorded them, in the marketplace currency. MCF status and packages come only from an Amazon read; until one is made they say so.</p>
  </main>;
}

export default function Screen({ data }: { data: ScreenData }) {
  switch (data.view) {
    case 'ready': return <ReadySamples snapshot={data.props.snapshot} report={data.props.report} />;
    case 'gated': return <main className="wa-stack"><CreatorHeader title="Sample shipments" subtitle="Creator Connections" /><CreatorGated /></main>;
    case 'error': return <CreatorLoadError title="Sample shipments" message={data.props.message} />;
  }
}
