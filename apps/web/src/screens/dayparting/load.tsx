import type { DaypartingResults } from '../../dayparting/results';
import { listDaypartingSchedules } from '@wizard-ads/db';
import { readDaypartingResults } from '../../dayparting/results';
import type { ScreenActor } from '../../server/page-read';

import type { ScreenParams } from '../types';

import { addDays, todayIso } from '../../../app/_lib/periods';

import { listProfiles } from '../../../app/_lib/profiles';

import { readDaypartingWorkspace } from '../../dayparting/data';

import {
  buildDaypartingHeatmap,
  isDaypartingMetric,
  summarizeDaypartingFacts
} from '../../dayparting/view';

interface PageProps {
  searchParams: Promise<{
    profile?: string;
    campaign?: string;
    metric?: string;
    evidence?: string;
    from?: string;
    to?: string;
  }>;
}

export async function load(access: ScreenActor, input: ScreenParams) {
  const searchParams = Promise.resolve(input.searchParams) as PageProps['searchParams'];

  const entry = access.entry;
  if (entry.state !== 'ok') {
    return { view: 'gated' as const, props: { entry } };
  }

  const params = await searchParams;
  const orgId = entry.context.active?.orgId ?? '';
  const profiles = await access.readSql((sql) => listProfiles({ sql }, orgId));
  const profile = access.selectProfile(profiles, await Promise.resolve(access.requestedProfile));
  if (profile === null) {
    return { view: 'empty' as const, props: {} };
  }

  const today = todayIso();
  const requestedFrom = validDate(params.from) ? params.from : addDays(today, -55);
  const requestedTo = validDate(params.to) ? params.to : today;
  const [from, to] = requestedFrom <= requestedTo
    ? [requestedFrom, requestedTo]
    : [addDays(today, -55), today];
  const metric = isDaypartingMetric(params.metric) ? params.metric : 'roas';
  const showAllEvidence = params.evidence === 'all';
  const campaignId = nonempty(params.campaign);
  const workspace = await access.readSql((sql) => readDaypartingWorkspace({ sql }, {
    orgId,
    profileId: profile.id,
    fromUtcHour: `${from}T00:00:00.000Z`,
    toUtcHour: `${to}T23:59:59.999Z`,
  }));
  const allSummary = summarizeDaypartingFacts(workspace.facts);
  const campaignChoices = campaignId !== null && !allSummary.campaigns.includes(campaignId)
    ? [campaignId, ...allSummary.campaigns]
    : allSummary.campaigns;
  const selectedFacts = campaignId === null
    ? workspace.facts
    : workspace.facts.filter((fact) => fact.campaignId === campaignId);
  const summary = summarizeDaypartingFacts(selectedFacts);
  const proposals = campaignId === null
    ? workspace.proposals
    : workspace.proposals.filter((proposal) => proposal.campaignId === campaignId);
  const evidence = showAllEvidence
    ? selectedFacts
    : selectedFacts.filter((fact) => fact.settlingState === 'settled');
  const cells = buildDaypartingHeatmap(evidence, metric);
  const cellMap = new Map(cells.map((cell) => [`${cell.dayOfWeek}|${cell.hour}`, cell]));

  const research=await access.snapshot(async snapshot=>{
    const schedules=await listDaypartingSchedules(snapshot,profile.id);
    const campaigns=await snapshot.sql<{id:string;name:string}[]>`select amazon_id as id,coalesce(name,amazon_id) as name from public.campaigns where org_id=${orgId} and profile_id=${profile.id} and ad_product='SP' and deleted_at is null order by name`;
    const results=Object.fromEntries(await Promise.all(schedules.filter(s=>s.enabledAt!==null).map(async s=>[s.id,await readDaypartingResults(snapshot,s)])));
    return {schedules,campaigns:[...campaigns],results:results as Record<string, DaypartingResults|null>};
  });
  return { view: 'ready' as const, props: { research, profile, summary, workspace, campaignId, campaignChoices, metric, showAllEvidence, from, to, selectedFacts, evidence, cellMap, proposals } };
}

function validDate(value: string | undefined): value is string {
  return value !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function nonempty(value: string | undefined): string | null {
  return value && value.trim().length > 0 ? value : null;
}
