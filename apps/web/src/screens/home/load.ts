import type { StreamConsumerEvidence } from '@wizard-ads/shared';
import { readStreamConsumerEvidence } from '../creative/stream-evidence-load';
import type { StreamExtensionEvidence } from '@wizard-ads/shared';
import { analyzeAccount, classifyCampaignCategory, computePacing, evaluate, pacingFlag } from '@wizard-ads/core';
import { readStreamExtensionEvidence, listHomeInsights, listHomeMarketGaps, listRecommendations } from '@wizard-ads/db';
import { loadCampaignDailyRows, loadHomeRankWatch, loadProfileDailyRows } from '../../../app/_lib/dashboard-data';
import { kpiTiles, totalsOf } from '../../optimizer/view';
import { addDays, precedingPeriod, periodFromParams } from '../../../app/_lib/periods';
import { can } from '../../auth/roles';
import { requireOrgRole } from '../../server/org-role';
import type { ScreenActor } from '../../server/page-read';
import type { ScreenParams } from '../types';
import { load as loadPerformance } from '../cockpit/load';
import { toProposalView } from '../../recommendations/view';

/** Retain pageRead's admission, selected profile and authenticated read lifetime. */
export async function load(access: ScreenActor, input: ScreenParams) {
  const base = await loadPerformance(access, input);
  if (base.view !== 'ready') return base;
  const { profile, period, today, accountRows } = base.props;
  const analysisWindow = { start: addDays(period.start, -8), end: period.end };
  const analysisRows = accountRows.filter((row) => row.date >= analysisWindow.start && row.date <= analysisWindow.end);
  const reportDate = analysisRows.at(-1)?.date ?? period.end;
  const weekEnd = addDays(today, -1);
  const from = input.searchParams['compareFrom'];
  const to = input.searchParams['compareTo'];
  const validDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  const comparison = validDate(from) && validDate(to) && from <= to
    ? periodFromParams({ from, to }, today) : precedingPeriod(period);
  const home = await access.read(async (handle, actor) => {
    const scope = { orgId: actor.orgId, profileId: profile.id };
    const [role, proposals, events, ranks, market, campaigns, monthRows, comparisonRows] = await Promise.all([
      requireOrgRole(handle, actor),
      listRecommendations(handle, { ...scope, statuses: ['proposed'], limit: 20000 }),
      listHomeInsights(handle, { ...scope, start: addDays(today, -6), end: today }),
      loadHomeRankWatch(handle, actor.orgId, profile.id, weekEnd),
      listHomeMarketGaps(handle, { ...scope, asOf: today }),
      loadCampaignDailyRows(handle, actor.orgId, profile.id, profile.label, analysisWindow),
      loadProfileDailyRows(handle, actor.orgId, profile.id, profile.label, { start: `${reportDate.slice(0, 8)}01`, end: reportDate }),
      loadProfileDailyRows(handle, actor.orgId, profile.id, profile.label, comparison),
    ]);
    const provider: { providerBudget?: StreamConsumerEvidence; providerDiagnostics?: StreamExtensionEvidence } = { providerBudget: await readStreamConsumerEvidence(handle, { ...scope, datasets: ['sp-budget-recommendations'], asOf: new Date().toISOString(), maxAgeMs: 86400000 }), providerDiagnostics: await readStreamExtensionEvidence(handle, { ...scope, datasetId: 'sponsored-ads-campaign-diagnostics-recommendations', asOf: new Date().toISOString(), maxAgeMs: 86400000 }) };
    const pacing = computePacing(monthRows, reportDate, profile.monthlyBudget);
    const pacingAlert = pacingFlag(pacing, null);
    const flags = evaluate(analyzeAccount(profile.label, reportDate, analysisRows,
      campaigns.map((row) => ({ ...row, category: classifyCampaignCategory(row.campaignName) }))), null, profile.goalLens);
    return {
      ...provider,
      tiles: kpiTiles(totalsOf(accountRows.filter((row) => row.date >= period.start && row.date <= period.end)), totalsOf(comparisonRows)),
      // No confirmed profile break-even economics exist in the current read contract.
      breakEvenAcos: null as number | null,
      comparison,
      canDecide: can(role, 'editTargets'),
      proposals: proposals.map((row) => {
        const view = toProposalView(row, { strategySnapshot: null });
        return { id: view.id, entityLabel: view.entityLabel, scope: view.scope, field: view.field,
          currentValue: view.currentValue, proposedValue: view.proposedValue, reason: view.reasonLabel };
      }),
      proposalsCapped: proposals.length === 20000,
      events, ranks: ranks.map((row) => ({ ...row, spend: null as number | null })), market, pacing,
      activeFlags: pacingAlert === null ? flags.active : [pacingAlert, ...flags.active],
      suppressedFlags: flags.suppressed,
      weekStart: addDays(weekEnd, -6), weekEnd,
    };
  });
  return { view: 'ready' as const, props: { ...base.props, pacing: home.pacing, home } };
}
