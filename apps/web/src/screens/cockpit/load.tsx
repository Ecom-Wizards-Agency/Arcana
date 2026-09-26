import type { FreshnessAssessment } from '@wizard-ads/ui';
import type { ScreenActor } from '../../server/page-read';

import type { ScreenParams } from '../types';

/**
 * `/` — the per-profile dashboard.
 *
 * A server component that reads the database and hands plain data to
 * presentational components. No Amazon call happens here (they all live in the
 * worker) and no doctrine value is hardcoded here (they arrive from the profile
 * row).
 *
 * The page is arranged around one idea: **say how much to trust these numbers
 * before showing them.** So the freshness bar and the crosscheck chip sit above
 * the tiles, not below, and they answer two different questions on purpose — the
 * bar says whether our numbers are current, the chip says whether they agree
 * with the incumbent's. A profile can be fresh and wrong, or stale and verified,
 * and an operator needs to see which.
 *
 * WP-21 replaced WP-06's `packages/ui` dashboard widgets with the `src/ui`
 * equivalents so the whole screen follows the theme; the data path is unchanged.
 *
 * Entry goes through `pageRead`, the same guard `/settings` and `/sync-status`
 * use: anonymous visitors are sent to `/login`, and every read below is scoped
 * by the org the gate resolved.
 */

import { analyzeAccount, classifyCampaignCategory, computePacing, evaluate, pacingFlag } from '@wizard-ads/core';

import type { DailyRow, Flag } from '@wizard-ads/core';

import { withAuthenticatedActor, type DbHandle } from '@wizard-ads/db';

import type { OrgActor } from '@wizard-ads/shared';

import { loadCrosscheckPanel } from '@wizard-ads/crosscheck-cli';



import { CrosscheckChip } from '../../../app/crosscheck/panel';

import { Badge, Card } from '../../ui/primitives';

import { FlagsCard } from '../../ui/dashboard';

import { kpiTiles, totalsOf } from '../../optimizer/view';

import type { FlagView } from '../../ui/dashboard';

import { readDashboardOperatingStatus } from '../../dashboard/operating-status';

import { loadCampaignDailyRows, loadProfileDailyRows } from '../../../app/_lib/dashboard-data';

import { addDays, screenPeriod, settledComparisonWindows, todayIso } from '../../../app/_lib/periods';

import { listProfiles } from '../../../app/_lib/profiles';

interface PageProps {
  searchParams: Promise<{ profile?: string; from?: string; to?: string; }>;
}

export async function load(access: ScreenActor, input: ScreenParams) {
  const searchParams = Promise.resolve(input.searchParams) as PageProps['searchParams'];

  const entry = access.entry;
  if (entry.state !== 'ok') {
    return { view: 'gated' as const, props: { entry } };
  }
  const orgId = entry.context.active?.orgId ?? '';
  const actor = { orgId, userId: entry.context.user.id };

  const params = await searchParams;
  const profileId = await Promise.resolve(access.requestedProfile);
  const today = todayIso();
  const period = screenPeriod('cockpit', params, today);
  const settled = settledComparisonWindows(period, today);
  const analysisWindow = { start: addDays(period.start, -8), end: period.end };

  const data = await access.readNullable(async (handle) => {
    const profiles = await listProfiles(handle, orgId);
    const profile = access.selectProfile(profiles, profileId);
    if (profile === null) return { profiles, profile: null };

    const accountWindow = {
      start:
        settled.comparison !== null && settled.comparison.start < analysisWindow.start
          ? settled.comparison.start
          : analysisWindow.start,
      end: period.end,
    };
    const accountRows = await loadProfileDailyRows(handle, orgId, profile.id, profile.label, accountWindow);

    return { profiles, profile, accountRows };
  });

  if (data === null) {
    return { view: 'no-database' as const, props: {} };
  }

  if (data.profile === null) {
    return { view: 'empty' as const, props: {} };
  }

  const {
    profile,
    accountRows = [],
  } = data;
  const context = { currencyCode: profile.currencyCode };

  const analysisRows = accountRows.filter(
    (row) => row.date >= analysisWindow.start && row.date <= analysisWindow.end,
  );
  const reportDate =
    analysisRows.length > 0
      ? (analysisRows[analysisRows.length - 1] as DailyRow).date
      : period.end;
  const pacing = computePacing(
    analysisRows.map((row) => ({ date: row.date, spend: row.spend })),
    reportDate,
    profile.monthlyBudget,
  );
  const pacingAlert = pacingFlag(pacing, null);

  const freshness = undefined as FreshnessAssessment | undefined; // The shell owns the coverage read.
  const inPeriod = accountRows.filter((row) => row.date >= period.start && row.date <= period.end);
  // A young profile's facts may begin after the settled window opens. Claiming
  // a sixteen-day window while summing four days of rows overstates confidence,
  // so the window is clamped to actual coverage and the subtitle says so.
  const coverageStart = accountRows[0]?.date ?? null;
  const currentWindow =
    settled.current !== null && coverageStart !== null && coverageStart > settled.current.start
      ? { start: coverageStart, end: settled.current.end }
      : settled.current;
  const coverageClamped =
    settled.current !== null && currentWindow !== null && currentWindow.start !== settled.current.start;
  const comparisonWindow = settled.comparison;
  const settledRows =
    currentWindow === null
      ? []
      : accountRows.filter((row) => row.date >= currentWindow.start && row.date <= currentWindow.end);
  const comparisonRows =
    comparisonWindow === null
      ? []
      : accountRows.filter(
        (row) => row.date >= comparisonWindow.start && row.date <= comparisonWindow.end,
      );
  const settlingWindow = {
    label: 'Settling · 14-day attribution window',
    start: settled.settling.start,
    end: settled.settling.end,
  };

  const cockpitDays = inPeriod.map((row) => ({
    date: row.date,
    impressions: row.impressions,
    clicks: row.clicks,
    spend: row.spend,
    sales: row.sales,
    orders: row.orders,
  }));
  const tiles = kpiTiles(
    settledRows.length === 0 ? null : totalsOf(settledRows),
    comparisonRows.length === 0 ? null : totalsOf(comparisonRows),
  );

  return {
    view: 'ready' as const, props: {
      profile, period, today, currentWindow, settled, coverageClamped, freshness, slot1: (<DashboardCrosscheck handle={entry.handle} actor={actor} profileId={profile.id} />), cockpitDays, tiles, settlingWindow, accountRows, pacing, context, slot2: (<OperatingStatus
        handle={entry.handle} actor={actor}
        orgId={orgId}
        profileId={profile.id}
      />), slot3: (<DashboardCampaignInsights
        handle={entry.handle} actor={actor}
        orgId={orgId}
        profileId={profile.id}
        profileLabel={profile.label}
        goalLens={profile.goalLens}
        analysisRows={analysisRows}
        analysisWindow={analysisWindow}
        reportDate={reportDate}
        pacingAlert={pacingAlert}
        currencyCode={profile.currencyCode}
        period={period}
      />)
    }
  };
}

async function DashboardCrosscheck({
  handle,
  actor,
  profileId,
}: {
  handle: DbHandle;
  actor: OrgActor;
  profileId: string;
}) {
  const model = await withAuthenticatedActor(handle, actor,
    (sql) => loadCrosscheckPanel({ sql }, { orgId: actor.orgId, profileId })).catch(() => null);
  return model === null ? null : <CrosscheckChip chip={model.chip} />;
}

async function DashboardCampaignInsights({
  handle,
  actor,
  orgId,
  profileId,
  profileLabel,
  goalLens,
  analysisRows,
  analysisWindow,
  reportDate,
  pacingAlert,
  currencyCode,
  period,
}: {
  handle: DbHandle;
  actor: OrgActor;
  orgId: string;
  profileId: string;
  profileLabel: string;
  goalLens: string | null;
  analysisRows: DailyRow[];
  analysisWindow: { start: string; end: string; };
  reportDate: string;
  pacingAlert: Flag | null;
  currencyCode: string;
  period: { start: string; end: string; };
}) {
  const campaignRows = await withAuthenticatedActor(handle, actor, (sql) => loadCampaignDailyRows(
    { sql }, orgId, profileId, profileLabel, analysisWindow,
  ));
  const categorised: DailyRow[] = campaignRows.map((row) => ({
    ...row,
    category: classifyCampaignCategory(row.campaignName),
  }));
  const analysis = analyzeAccount(profileLabel, reportDate, analysisRows, categorised);
  const flags = evaluate(analysis, null, goalLens);
  const activeFlags: Flag[] =
    pacingAlert === null ? flags.active : [pacingAlert, ...flags.active];

  const byCampaign = new Map<
    string,
    {
      name: string;
      category: string;
      spend: number;
      sales: number;
      clicks: number;
      orders: number;
    }
  >();
  for (const row of categorised) {
    const name = row.campaignName ?? '(unknown campaign)';
    const acc = byCampaign.get(name) ?? {
      name,
      category: String(row.category ?? classifyCampaignCategory(name)),
      spend: 0,
      sales: 0,
      clicks: 0,
      orders: 0,
    };
    acc.spend += row.spend;
    acc.sales += row.sales;
    acc.clicks += row.clicks;
    acc.orders += row.orders;
    byCampaign.set(name, acc);
  }
  const campaignSummary = [...byCampaign.values()]
    .sort((left, right) => right.spend - left.spend)
    .slice(0, 12);

  return (
    <>
      <FlagsCard active={activeFlags as FlagView[]} suppressed={flags.suppressed as FlagView[]} />
      <CampaignTable
        rows={campaignSummary}
        currencyCode={currencyCode}
        profileId={profileId}
        period={period}
      />
    </>
  );
}

async function OperatingStatus({
  handle,
  actor,
  orgId,
  profileId,
}: {
  handle: DbHandle;
  actor: OrgActor;
  orgId: string;
  profileId: string;
}) {
  const status = await withAuthenticatedActor(handle, actor,
    (sql) => readDashboardOperatingStatus({ sql }, { orgId, profileId }));
  const openBatch = status.stagedBatch;
  const stockNeedsReview = status.stockSignals > 0;
  const observationNeedsReview = status.observations.revert > 0 || status.observations.settling > 0;

  return (
    <div id="operating-status">
      <Card
        title="Operating status"
        subtitle="Account constraints and evidence behind the next optimizer decision."
        actions={<a className="wa-btn wa-btn--ghost wa-btn--sm" href={`/optimizer/groups?profile=${profileId}`}>Manage groups</a>}
      >
        <div className="wa-operating-status">
          <OperatingSignal
            label="Stock gate"
            value={stockNeedsReview ? 'Review' : 'Unknown'}
            detail={stockNeedsReview
              ? `${status.stockSignals} stock signal${status.stockSignals === 1 ? '' : 's'} need review.`
              : 'No validated inventory signal is available.'}
            tone={stockNeedsReview ? 'warn' : 'neutral'}
          />
          <OperatingSignal
            label="Optimization groups"
            value={`${status.campaigns.assigned}/${status.campaigns.total} assigned`}
            detail={status.campaigns.unassigned === 0
              ? `${status.groupCount} group${status.groupCount === 1 ? '' : 's'} cover the campaign roster.`
              : `${status.campaigns.unassigned} campaign${status.campaigns.unassigned === 1 ? '' : 's'} still need a group.`}
            tone={status.campaigns.unassigned === 0 && status.campaigns.total > 0 ? 'good' : 'warn'}
          />
          <OperatingSignal
            label="Open export batch"
            value={openBatch === null ? 'Clear' : `${openBatch.rows} staged`}
            detail={openBatch === null
              ? 'No exported change set is waiting for operator handling.'
              : `${openBatch.optGroup} · ${openBatch.lever} · Amazon unchanged`}
            tone={openBatch === null ? 'good' : 'warn'}
          />
          <OperatingSignal
            label="Evidence loop"
            value={status.observations.revert > 0
              ? `${status.observations.revert} revert`
              : status.observations.settling > 0
                ? `${status.observations.settling} observing`
                : `${status.observations.complete} complete`}
            detail={`${status.observations.synchronized} synchronized · ${status.observations.hold} hold`}
            tone={status.observations.revert > 0 ? 'bad' : observationNeedsReview ? 'warn' : 'neutral'}
          />
        </div>
        <div className="wa-operating-status__actions">
          <a href={`/optimizer?profile=${profileId}`}>Open Campaign Optimizer →</a>
          <a href={`/recommendations?profile=${profileId}`}>Review recommendations →</a>
        </div>
      </Card>
    </div>
  );
}

function OperatingSignal({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone: 'good' | 'warn' | 'bad' | 'neutral';
}) {
  return (
    <div className="wa-operating-signal">
      <span>{label}</span>
      <strong>{value}</strong>
      <Badge tone={tone}>{detail}</Badge>
    </div>
  );
}

function CampaignTable({
  rows,
  currencyCode,
  profileId,
  period,
}: {
  rows: { name: string; category: string; spend: number; sales: number; clicks: number; orders: number; }[];
  currencyCode: string;
  profileId: string;
  period: { start: string; end: string; };
}) {
  if (rows.length === 0) return null;
  const money = (v: number) =>
    v.toLocaleString('en-US', { style: 'currency', currency: currencyCode, maximumFractionDigits: v >= 100 ? 0 : 2 });
  const totalSpend = rows.reduce((a, r) => a + r.spend, 0) || 1;
  return (
    <Card>
      <div className="wa-card-head">
        <h2 className="wa-card-title">Top campaigns by spend</h2>
        <a className="wa-btn wa-btn--ghost wa-btn--sm" href={`/grid?profile=${profileId}&from=${period.start}&to=${period.end}`}>
          Open the grid →
        </a>
      </div>
      <table className="wa-table wa-table--dense">
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>Campaign</th>
            <th style={{ textAlign: 'left' }}>Category</th>
            <th>Spend</th>
            <th>Share</th>
            <th>Ad Sales</th>
            <th>ACOS</th>
            <th>Clicks</th>
            <th>Orders</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name}>
              <td style={{ textAlign: 'left' }}>
                <span className="wa-campaign-name">
                  {row.name.split(' | ').map((seg, i) => (
                    <span key={i} className={i === 0 ? 'wa-campaign-seg wa-campaign-seg--head' : 'wa-campaign-seg'}>
                      {seg}
                    </span>
                  ))}
                </span>
              </td>
              <td style={{ textAlign: 'left' }}>
                <span className={`wa-cat wa-cat--${row.category.toLowerCase()}`}>{row.category}</span>
              </td>
              <td>{money(row.spend)}</td>
              <td>
                <span className="wa-sharebar" aria-label={`${((row.spend / totalSpend) * 100).toFixed(0)}% of listed spend`}>
                  <span className="wa-sharebar__fill" style={{ width: `${Math.max(3, (row.spend / totalSpend) * 100)}%` }} />
                </span>
              </td>
              <td>{money(row.sales)}</td>
              <td>{row.spend > 0 && row.sales > 0 ? `${((row.spend / row.sales) * 100).toFixed(1)}%` : '—'}</td>
              <td>{row.clicks.toLocaleString('en-US')}</td>
              <td>{row.orders.toLocaleString('en-US')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
