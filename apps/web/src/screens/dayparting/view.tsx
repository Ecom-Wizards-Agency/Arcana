import type { CSSProperties, ReactNode } from 'react';

import type { DaypartingScheduleProposal } from '@wizard-ads/shared';

import { gateMessage } from '../../ui/gate-message';

import { Badge, Banner, Card, EmptyState, Field, PageHeader, Select } from '../../ui/primitives';

import { page } from '../../ui/tokens';

import {
  DAYPARTING_METRICS,
  formatDaypartingMetric,
  type DaypartingCell,
  type DaypartingMetric
} from '../../dayparting/view';

import styles from '../../../app/dayparting/dayparting.module.css';

import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;

export default function ScreenView({ data }: { data: ScreenData; }) {
  switch (data.view) {
    case 'gated': return renderGated(data.props);
    case 'empty': return renderEmpty(data.props);
    case 'ready': return renderReady(data.props);
  }
}

function renderGated({ entry }: Extract<ScreenData, { view: 'gated'; }>['props']) {
  return (<main style={page}><PageHeader title="Dayparting" /><p className="wa-page-sub">{gateMessage(entry.state)}</p></main>);
}

function renderEmpty(_props: Extract<ScreenData, { view: 'empty'; }>['props']) {
  return (<main style={page}>
    <PageHeader title="Dayparting" />
    <EmptyState
      title="No profiles yet"
      body="Connect Amazon Ads before Marketing Stream evidence can be scoped to an account."
      action={<a className="wa-btn wa-btn--sm" href="/settings/connections">Connect Amazon Ads</a>}
    />
  </main>);
}

function renderReady({ profile, summary, workspace, campaignId, campaignChoices, metric, showAllEvidence, from, to, selectedFacts, evidence, cellMap, proposals }: Extract<ScreenData, { view: 'ready'; }>['props']) {
  return (<main style={page}>
    <PageHeader
      title="Dayparting"
      subtitle={`${profile.label} · ${summary.timeZone ?? profile.timezone} · local account time`}
      actions={<Badge tone="info">Automatic execution off</Badge>}
    />

    <div className="wa-stack">
      <Banner tone="info" role="status">
        Marketing Stream evidence is read-only. Schedules below are proposals for export; Arcana does not apply bid or budget changes in the current release.
      </Banner>
      {!workspace.maturityPolicyConfigured ? (
        <Banner tone="warn" role="status">
          No tenant dayparting settling window is configured. Stored evidence states are shown as recorded and cannot age automatically until an operator adds that policy.
        </Banner>
      ) : null}

      <section className={styles.summary} aria-label="Dayparting evidence summary">
        <SummaryTile value={summary.settledHours} label="Settled hours" />
        <SummaryTile value={summary.settlingHours} label="Settling hours" warn={summary.settlingHours > 0} />
        <SummaryTile value={summary.cappedHours} label="Budget-capped hours" warn={summary.cappedHours > 0} />
        <SummaryTile value={workspace.coverage.ledgerMessages} label="Raw ledger messages" />
      </section>

      <Card title="Hourly performance" subtitle="Day of week × hour in the profile timezone. Final proposals use settled evidence only.">
        <form method="get" className={styles.filters}>
          <input type="hidden" name="profile" value={profile.id} />
          <Field label="Campaign" htmlFor="daypart-campaign">
            <Select id="daypart-campaign" name="campaign" defaultValue={campaignId ?? ''} compact>
              <option value="">All campaigns</option>
              {campaignChoices.map((id) => <option value={id} key={id}>{id}</option>)}
            </Select>
          </Field>
          <Field label="Metric" htmlFor="daypart-metric">
            <Select id="daypart-metric" name="metric" defaultValue={metric} compact>
              {DAYPARTING_METRICS.map((value) => <option value={value} key={value}>{METRIC_LABELS[value]}</option>)}
            </Select>
          </Field>
          <Field label="Evidence" htmlFor="daypart-evidence">
            <Select id="daypart-evidence" name="evidence" defaultValue={showAllEvidence ? 'all' : 'settled'} compact>
              <option value="settled">Settled only</option>
              <option value="all">Include settling</option>
            </Select>
          </Field>
          <Field label="From" htmlFor="daypart-from"><input className="wa-input wa-input--sm" id="daypart-from" type="date" name="from" defaultValue={from} /></Field>
          <Field label="To" htmlFor="daypart-to"><input className="wa-input wa-input--sm" id="daypart-to" type="date" name="to" defaultValue={to} /></Field>
          <button className="wa-btn wa-btn--sm" type="submit">Update view</button>
        </form>

        {selectedFacts.length === 0 ? (
          <EmptyState
            title="No hourly evidence in this window"
            body="Marketing Stream must deliver traffic, conversion, and budget-usage messages through the account’s SQS integration before a schedule can be evaluated."
            meta={`Requested ${from} through ${to}. No synthetic bootstrap is shown as authoritative.`}
          />
        ) : evidence.length === 0 ? (
          <EmptyState
            title="Hourly evidence is still settling"
            body="The ledger has data, but none of these hours is mature enough for a final proposal. Include settling evidence to inspect it without treating it as final."
            action={<a className="wa-btn wa-btn--sm" href={daypartHref(profile.id, { campaignId, metric, from, to, evidence: 'all' })}>Include settling evidence</a>}
          />
        ) : (
          <Heatmap cells={cellMap} metric={metric} currencyCode={profile.currencyCode} />
        )}

        <div className={styles.legend}>
          <span><i className={styles.legendLow} /> Lower relative value</span>
          <span><i className={styles.legendHigh} /> Higher relative value</span>
          <span><i className={styles.legendCapped} /> Budget capped</span>
          {showAllEvidence ? <span><i className={styles.legendSettling} /> Contains settling/revised evidence</span> : null}
        </div>
      </Card>

      <Card
        title="Proposed schedules"
        subtitle="Confidence-shrunk blocks use settled evidence and merge adjacent equivalent hours. Export is the only action."
      >
        {proposals.length === 0 ? (
          <EmptyState
            title="No schedule proposals yet"
            body="A proposal appears only after settled hourly evidence and tenant-approved modelling inputs are available. Automatic execution remains off."
          />
        ) : (
          <div className={styles.proposals}>
            {proposals.map((proposal) => <ProposalCard key={proposal.id ?? `${proposal.campaignId}-${proposal.evidenceEnd}`} proposal={proposal} />)}
          </div>
        )}
      </Card>
    </div>
  </main>);
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const METRIC_LABELS: Record<DaypartingMetric, string> = {
  roas: 'ROAS',
  conversion_rate: 'Conversion rate',
  acos: 'ACOS',
  ctr: 'CTR',
  cpc: 'CPC',
  spend: 'Spend',
  sales: 'Sales',
  orders: 'Orders',
};

function Heatmap({
  cells,
  metric,
  currencyCode,
}: {
  cells: ReadonlyMap<string, DaypartingCell>;
  metric: DaypartingMetric;
  currencyCode: string;
}): ReactNode {
  return (
    <div className={styles.heatmapScroll}>
      <div className={styles.heatmap} role="grid" aria-label={`${METRIC_LABELS[metric]} by local day and hour`}>
        <span className={styles.corner} />
        {Array.from({ length: 24 }, (_, hour) => <span role="columnheader" className={styles.hour} key={hour}>{String(hour).padStart(2, '0')}</span>)}
        {DAYS.flatMap((day, dayOfWeek) => [
          <strong role="rowheader" className={styles.day} key={`${day}-label`}>{day}</strong>,
          ...Array.from({ length: 24 }, (_, hour) => {
            const cell = cells.get(`${dayOfWeek}|${hour}`);
            return <HeatmapCell key={`${dayOfWeek}-${hour}`} cell={cell} metric={metric} currencyCode={currencyCode} />;
          }),
        ])}
      </div>
    </div>
  );
}

function HeatmapCell({
  cell,
  metric,
  currencyCode,
}: {
  cell: DaypartingCell | undefined;
  metric: DaypartingMetric;
  currencyCode: string;
}): ReactNode {
  if (!cell) return <span role="gridcell" className={styles.emptyCell} aria-label="No evidence" />;
  const value = formatDaypartingMetric(cell.value, metric, currencyCode);
  const state = cell.settlingFacts > 0 || cell.revisedFacts > 0 ? 'contains unsettled evidence' : 'settled';
  const title = `${DAYS[cell.dayOfWeek]} ${String(cell.hour).padStart(2, '0')}:00 · ${METRIC_LABELS[metric]} ${value} · spend ${formatDaypartingMetric(cell.spend, 'spend', currencyCode)} · sales ${formatDaypartingMetric(cell.sales, 'sales', currencyCode)} · ${cell.orders} orders · ${state}${cell.cappedFacts > 0 ? ' · budget capped' : ''}`;
  const style = { '--daypart-mix': `${Math.round(8 + cell.strength * 62)}%` } as CSSProperties;
  return (
    <span
      role="gridcell"
      className={`${styles.cell} ${cell.cappedFacts > 0 ? styles.capped : ''} ${cell.settlingFacts > 0 || cell.revisedFacts > 0 ? styles.settling : ''}`}
      style={style}
      title={title}
      aria-label={title}
    >
      {value}
    </span>
  );
}

function ProposalCard({ proposal }: { proposal: DaypartingScheduleProposal; }): ReactNode {
  return (
    <article className={styles.proposal}>
      <div className={styles.proposalHead}>
        <div><strong>{proposal.baselineLabel}</strong><small>{proposal.campaignId} · {proposal.evidenceStart} to {proposal.evidenceEnd}</small></div>
        <Badge tone={proposal.status === 'proposed' ? 'info' : 'neutral'}>{proposal.status}</Badge>
      </div>
      <div className={styles.proposalMeta}>
        <span><strong>{proposal.settledHours}</strong> settled hours</span>
        <span><strong>{proposal.blocks.length}</strong> merged blocks</span>
        <span><strong>{proposal.blocks.length === 0 ? '—' : `${Math.round(Math.min(...proposal.blocks.map((block) => block.confidence)) * 100)}%`}</strong> minimum confidence</span>
      </div>
      <div className={styles.blocks}>
        {proposal.blocks.length === 0 ? <span className="wa-hint">Evidence supports the baseline; no hourly adjustment is proposed.</span> : proposal.blocks.map((block, index) => (
          <span className={styles.block} key={`${block.dayOfWeek}-${block.startHour}-${index}`}>
            {DAYS[block.dayOfWeek]} {String(block.startHour).padStart(2, '0')}:00–{String(block.endHour).padStart(2, '0')}:00
            <strong>{block.adjustmentPercent > 0 ? '+' : ''}{block.adjustmentPercent}%</strong>
            <small>{Math.round(block.confidence * 100)}% confidence</small>
          </span>
        ))}
      </div>
      {proposal.id ? (
        <div className={styles.exportActions}>
          <span>Review/export only · Amazon unchanged</span>
          <a className="wa-btn wa-btn--sm" href={`/api/dayparting/export?id=${proposal.id}&profileId=${proposal.profileId}&format=csv`}>Export CSV</a>
          <a className="wa-btn wa-btn--sm" href={`/api/dayparting/export?id=${proposal.id}&profileId=${proposal.profileId}&format=json`}>Export JSON</a>
        </div>
      ) : null}
    </article>
  );
}

function SummaryTile({ value, label, warn = false }: { value: number; label: string; warn?: boolean; }): ReactNode {
  return <div className={`${styles.summaryTile} ${warn ? styles.summaryWarn : ''}`}><strong>{value.toLocaleString('en-US')}</strong><span>{label}</span></div>;
}

function daypartHref(
  profileId: string,
  input: { campaignId: string | null; metric: DaypartingMetric; from: string; to: string; evidence: string; },
): string {
  const query = new URLSearchParams({ profile: profileId, metric: input.metric, from: input.from, to: input.to, evidence: input.evidence });
  if (input.campaignId) query.set('campaign', input.campaignId);
  return `/dayparting?${query.toString()}`;
}
