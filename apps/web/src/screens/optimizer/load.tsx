import type { FreshnessAssessment } from '@wizard-ads/ui';
import type { ScreenActor } from '../../server/page-read';

import type { ScreenParams } from '../types';

/**
 * `/optimizer` — the Campaign Optimizer, laid out like AdLabs' "Bid Optimizer"
 * (`https://github.com/Ecom-Wizards-Agency/Arcana/blob/dd4f3887f626128250abee537f374712ca42717c/tools/recon/04-optimizer.md`).
 *
 * This is the AdLabs-style *presentation* of the recommendations the engine
 * (WP-07) already produces. It reads them — it does not compute them — and lays
 * them out the way the recon says the incumbent does: a KPI tile row, a
 * daily/weekly/monthly trend chart, the reason-coverage clusters, and a preview
 * grouped into optimization groups, each proposal carrying the change-reasons /
 * limit-reasons split as two separate pill columns. Campaign buckets are named
 * honestly; they do not stand in for the persisted optimization-group model.
 * The three-act QA-and-apply
 * gesture stays where it is tested and trusted, on `/recommendations`; this page
 * links through to it.
 *
 * Entry goes through `pageRead`, the same guard the dashboard and grid use, and
 * every read below is scoped by the org the gate resolved.
 */



import { can } from '../../auth/roles';

import { toProposalView } from '../../recommendations/view';

import { reasonCoverage } from '../../recommendations/view';

import {
  campaignReviewGroups,
  kpiTiles,
  settingsSummary,
  totalsOf,
} from '../../optimizer/view';

import { buildOptimizerCampaignRows } from '../../optimizer/campaigns';

import { resolveOneTimePreviewReadiness } from '../../optimizer/readiness';

import { loadOptimizerPageData } from '../../../app/_lib/optimizer-page-data';

import { periodFromParams, settledComparisonWindows, todayIso } from '../../../app/_lib/periods';

import { listProfiles } from '../../../app/_lib/profiles';

interface PageProps {
  searchParams: Promise<{
    profile?: string;
    from?: string;
    to?: string;
    run?: string;
    batch?: string;
    preset?: string;
  }>;
}

export async function load(access: ScreenActor, input: ScreenParams) {
  const searchParams = Promise.resolve(input.searchParams) as PageProps['searchParams'];

  const entry = access.entry;
  if (entry.state !== 'ok') {
    return { view: 'gated' as const, props: { entry } };
  }
  const { handle, context } = entry;
  const orgId = context.active?.orgId ?? '';
  const mayRunOptimizer = can(context.active?.role, 'editTargets');

  const params = await searchParams;
  const profileId = await Promise.resolve(access.requestedProfile);
  const today = todayIso();
  const period = periodFromParams(params, today);
  const settled = settledComparisonWindows(period, today);

  const profiles = await access.readSql((sql) => listProfiles({ sql }, orgId));
  const profile = access.selectProfile(profiles, profileId);
  if (profile === null) {
    return { view: 'empty' as const, props: {} };
  }

  const [pageData, previewReadiness] = await Promise.all([
    access.readSql((sql) => loadOptimizerPageData({
      handle: { sql },
      orgId,
      profile,
      period,
      settledComparison: settled.comparison,
      ...(params.run === undefined ? {} : { requestedRunId: params.run }),
    })),
    resolveOneTimePreviewReadiness(handle),
  ]);
  const {
    runs,
    run,
    records,
    optimizationWorkspace,
    periodRows,
    comparisonRows,
    campaignFacts,
  } = pageData;
  const proposals = records.map((record) =>
    toProposalView(record, { strategySnapshot: run?.strategySnapshot ?? null, ...(run?.executionSnapshot === undefined ? {} : { executionSnapshot: run.executionSnapshot }) }),
  );

  // Same clamp the dashboard applies: never claim settled days that have no
  // synced facts behind them.
  const coverageStart = periodRows[0]?.date ?? null;
  const currentWindow =
    settled.current !== null && coverageStart !== null && coverageStart > settled.current.start
      ? { start: coverageStart, end: settled.current.end }
      : settled.current;
  const settledRows =
    currentWindow === null
      ? []
      : periodRows.filter(
        (row) => row.date >= currentWindow.start && row.date <= currentWindow.end,
      );
  const tiles = kpiTiles(
    settledRows.length === 0 ? null : totalsOf(settledRows),
    comparisonRows.length === 0 ? null : totalsOf(comparisonRows),
  );
  const campaignGroups = campaignReviewGroups(proposals);
  const coverage = reasonCoverage(proposals);
  const summary = settingsSummary(proposals);
  const campaignRows = buildOptimizerCampaignRows(
    campaignFacts,
    optimizationWorkspace.groups,
    proposals,
    true,
  );
  const freshness = undefined as FreshnessAssessment | undefined; // The shell owns the coverage read.

  const cockpitDays = periodRows.map((row) => ({
    date: row.date,
    impressions: row.impressions,
    clicks: row.clicks,
    spend: row.spend,
    sales: row.sales,
    orders: row.orders,
  }));

  return { view: 'ready' as const, props: { run, summary, profile, period, today, params, freshness, runs, cockpitDays, tiles, settled, coverageStart, campaignRows, mayRunOptimizer, previewReadiness, coverage, proposals, campaignGroups } };
}
