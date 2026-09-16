import { RetailEvidencePanel } from '../grid/spapi-evidence';
import { EmptyState, formatValue } from '@wizard-ads/ui';
import { remainingBudget, resolvePacingThresholds } from '@wizard-ads/core';
import { gateMessage } from '../../ui/gate-message';
import { HomeCard } from './card';
import { ProposalsInbox } from './proposals';
import type { load } from './load';
import './home.css';

export type ScreenData = Awaited<ReturnType<typeof load>>;
export type HomeReady = Extract<ScreenData, { view: 'ready' }>['props'];

export default function HomeScreen({ data }: { data: ScreenData }) {
  if (data.view !== 'ready') return <main className="wa-home">
    {data.view === 'empty' ? <EmptyState title="No profiles yet" body="Connect Amazon Ads to load your advertising profiles."
      action={<a className="wa-btn" href="/settings/connections">Connect Amazon Ads</a>} /> :
      <EmptyState variant="gated" title="Home is unavailable" body={gateMessage(data.view === 'gated' ? data.props.entry.state : 'no-database')} />}
  </main>;
  return <HomeContent {...data.props} />;
}

export function HomeContent({ profile, context, home, period }: HomeReady) {
  const pacing = home.pacing;
  const thresholds = resolvePacingThresholds();
  const money = (value: number | null) => value === null ? '—' : value.toLocaleString('en-US', { style: 'currency', currency: profile.currencyCode });
  const measuredPacing = pacing !== null && pacing.daysWithData > 0;
  return <main className="wa-home" data-profile-id={profile.id}>
    <section className="wa-home-kpis" aria-label="Performance summary">
      {['spend', 'sales', 'acos', 'orders'].map((metric) => {
        const tile = home.tiles.find((candidate) => candidate.metric === metric)!;
        const delta = tile.deltaPct;
        const tone = delta === null || delta === 0 || tile.better === null ? 'neutral'
          : (delta > 0) === (tile.better === 'higher') ? 'good' : metric === 'acos' ? 'warn' : 'bad';
        return <div className="wa-home-kpi" key={metric} aria-label={metric === 'sales' ? 'Sales' : tile.label}>
          <span>{metric === 'sales' ? 'Sales' : tile.label}</span>
          <strong>{tile.scale === 'money' ? money(tile.value) : metric === 'acos' && tile.value !== null ? `${(tile.value * 100).toFixed(2)}%` : formatValue(tile.value, tile.scale, context)}</strong>
          <small data-tone={tone} aria-label="Comparison delta">{delta === null ? '—' : `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${(Math.abs(delta) * 100).toFixed(1)}%`}</small>
        </div>;
      })}
      <div className="wa-home-kpi" aria-label="Break-even ACOS"><span>Break-even ACOS</span>
        <strong>{formatValue(home.breakEvenAcos, 'percent', context)}</strong>
        <small data-tone={home.breakEvenAcos === null ? 'neutral' : 'good'}>{home.breakEvenAcos === null ? 'not measured' : 'confirmed'}</small>
      </div>
    </section>
    <RetailEvidencePanel evidence={home.retail} spend={home.retailSpend} previous={home.previousRetail} previousPeriod={home.comparison} start={period.start} end={period.end} />
    <div className="wa-home-grid">
      <ProposalsInbox key={profile.id} proposals={home.proposals} canDecide={home.canDecide} profileId={profile.id} capped={home.proposalsCapped} />
      <HomeCard title="Flags" subtitle="Raised and noted sit as peers. A suppressed flag is never hidden in a disclosure.">
        <div className="wa-home-flags">
          <div><h3 data-tone="bad">Raised ({home.activeFlags.length})</h3>
            {home.activeFlags.length === 0 ? <p className="wa-home-note">No active flags.</p> :
              <ul aria-label="Active flags">{home.activeFlags.map((flag, index) => <li key={`${flag.scope}-${flag.metric}-${index}`} data-tone={flag.severity === 'info' ? 'neutral' : flag.severity === 'warn' ? 'warn' : 'bad'}>
                <p>{flag.message}</p><p className="wa-home-flag-reason">{flag.likelyCause}</p>
              </li>)}</ul>}
          </div>
          <div><h3>Noted, not flagged ({home.suppressedFlags.length})</h3>
            {home.suppressedFlags.length === 0 ? <p className="wa-home-note">No suppressed findings.</p> :
              <ul aria-label="Suppressed flags">{home.suppressedFlags.map((flag, index) => <li key={`${flag.scope}-${flag.metric}-${index}`} data-tone="neutral">
                <p>{flag.message}</p><p className="wa-home-flag-reason">{flag.suppressedReason ?? 'No suppression reason was recorded.'}</p>
              </li>)}</ul>}
          </div>
        </div>
      </HomeCard>
      <HomeCard title="Pacing" subtitle="Cut order is doctrine, not a per-client judgement.">
        {pacing === null ? <>
          <p className="wa-home-note">No monthly budget on file — pacing is not computed.</p>
          <p className="wa-home-caption">A fabricated pace is worse than none. Set a budget in <a href={`/settings/profiles?profile=${encodeURIComponent(profile.id)}`}>Settings → Strategy</a>.</p>
        </> : <div className="wa-home-pacing-figures">
          {measuredPacing ? <div className="wa-home-pace-heading"><strong className="wa-home-chip" data-tone={pacing.status === 'act' ? 'bad' : pacing.status === 'on_pace' ? 'good' : 'warn'}>
            {{ on_pace: 'On pace', warn: 'Warn', act: 'Act', underpace: 'Underpace' }[pacing.status]} · pace {pacing.pace === null ? '—' : `${pacing.pace.toFixed(2)}×`}
          </strong><span>act at {thresholds.act_above} · underpace at {thresholds.underpace_below}</span></div> :
            <EmptyState variant="not-measured" title="Not measured" body="No month-to-date spend observations are available." />}
          <dl className="wa-home-budget">
            <div><dt>Spent so far this month</dt><dd><strong>{money(measuredPacing ? pacing.mtdSpend : null)}</strong></dd></div>
            <div><dt>Budget for the month so far</dt><dd>{money(pacing.budgetToDate)}</dd></div>
            <div><dt>Monthly budget</dt><dd>{money(pacing.monthlyBudget)}</dd></div>
            <div><dt>Remaining · derived, not stored</dt><dd>{money(remainingBudget(pacing.monthlyBudget, measuredPacing ? pacing.mtdSpend : null))}</dd></div>
          </dl>
          <p className="wa-home-caption">Day {pacing.dayOfMonth} of {pacing.daysInMonth}. Pace is month-to-date spend divided by the budget for the month so far.</p>
          {!pacing.coverageComplete ? <p className="wa-home-caption" data-tone="warn">Spend coverage is incomplete; pace may be understated and remaining budget overstated.</p> : null}
        </div>}
        <ol className="wa-home-cut-order" aria-label="Budget cut order">{['Waste', 'Discovery', 'Profit', 'Rank — operator only'].map((label, index) =>
          <li key={label} data-tone={index === 3 ? 'warn' : 'neutral'}>{index + 1} {label}</li>)}</ol>
      </HomeCard>
      <div className="wa-home-right-stack">
        <HomeCard title="Rank watch" subtitle="Where ads and organic disagree.">
          {home.ranks.length === 0 ? <EmptyState variant="not-measured" title="Not measured" body="No recent organic rank observations are available for this profile." /> :
            <ul className="wa-home-ranks" aria-label="Rank movements">{home.ranks.map((row) => <li key={`${row.asin}-${row.keyword}`} data-tone={row.movement === null || row.movement === 0 ? 'neutral' : row.movement > 0 ? 'good' : 'warn'}>
              <div><strong>{row.keyword}</strong><p>{row.movement === null ? 'Weekly change not measured' : row.movement === 0 ? 'Unchanged this week' : `${row.movement > 0 ? 'Climbing' : 'Slipping'} · ${row.movement > 0 ? 'Up' : 'Down'} ${Math.abs(row.movement)} places`}</p></div>
              <strong className="wa-home-rank-value">{row.currentRank === null ? '—' : `#${row.currentRank}`}{row.previousRank === null ? '' : ` ← #${row.previousRank}`}</strong>
              <span className="wa-home-rank-spend" title="Ad spend attributable to this product and keyword" aria-label="Keyword spend">{money(row.spend)}</span>
            </li>)}</ul>}
        </HomeCard>
        <HomeCard title="Events this week" subtitle="Competitor deals and analyst observations.">
          {home.events.length === 0 ? <EmptyState title="No events this week" body="No events have been recorded for this profile this week." /> :
            <ul className="wa-home-events" aria-label="Weekly events">{home.events.map((event) => <li key={event.id}>
              <div><strong>{event.title}</strong><span>{event.source === 'keepa' ? 'Keepa' : event.source === 'headless_analyst' ? 'Analyst' : event.source}</span></div>
              <p>{event.body}</p><time>{event.date}</time>
            </li>)}</ul>}
        </HomeCard>
      </div>
      <HomeCard title="Campaigns near their limit" subtitle="Which campaigns are running out of daily budget.">
        <EmptyState variant="not-measured" title="Not measured" body="Budget exhaustion is only visible in Amazon’s hourly Marketing Stream feed. Budget usage from that feed is not available for this profile. The daily budget we store does not say whether a campaign ever ran out." />
        <p className="wa-home-caption">When the feed is on, this lists each campaign with the share of the day it spent its budget, worst first.</p>
      </HomeCard>
      <HomeCard title="Market position" subtitle="Distance to the product behind you, not your rank on its own.">
        {home.market.length === 0 ? <>
          <EmptyState variant="not-measured" title="Not measured" body="No comparable Best Seller Rank and tracked competitor observations are available for this profile. Both are needed before a gap can be drawn." />
          <ul className="wa-home-explanation"><li>Your Best Seller Rank, plotted so that rank 1 sits at the top.</li>
            <li>The gap to the next product, as a share of your own rank.</li>
            <li>An alert when that gap closes past the threshold you set, saying whether you slipped or they gained.</li></ul>
        </> : <><ul className="wa-home-market" aria-label="Nearest competitors">{home.market.map((row) => <li key={`${row.ourAsin}-${row.category}`}>
          <strong>{row.ourAsin}</strong><p>{Math.abs(row.gap).toLocaleString('en-US')} places {row.gap === 0 ? 'apart from' : row.gap > 0 ? 'behind' : 'ahead of'} {row.competitorAsin}</p>
          <p>{row.category} · BSR {row.ourRank.toLocaleString('en-US')} vs {row.competitorRank.toLocaleString('en-US')} · {row.observedOn}</p>
        </li>)}</ul><a className="wa-home-review" href={`/market-position?profile=${encodeURIComponent(profile.id)}`}>View market position →</a></>}
      </HomeCard>
    </div>
  </main>;
}
