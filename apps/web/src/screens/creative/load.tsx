import type { ScreenActor } from '../../server/page-read';
import { CreativeLifecycleStatusView, CreativeResultsView } from './evidence-view';

import type { ScreenParams } from '../types';

import {
  readCreativePerformance,
  readLatestCreativeSyncJobState,
  readLatestCreativeSyncSnapshot
} from '@wizard-ads/db';

import type { CreativeLifecycleEvidence } from '../../creative/lifecycle';

import { creativeSyncPilotFromEnv } from '../../server/sync-tick';

import { periodFromParamsThroughToday, todayIsoInTimeZone } from '../../../app/_lib/periods';

import { listProfiles } from '../../../app/_lib/profiles';

interface PageProps {
  searchParams: Promise<{
    profile?: string | string[];
    from?: string | string[];
    to?: string | string[];
    preset?: string | string[];
  }>;
}

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function load(access: ScreenActor, input: ScreenParams) {
  const searchParams = Promise.resolve(input.searchParams) as PageProps['searchParams'];

  const entry = access.entry;
  if (entry.state !== 'ok') {
    return { view: 'gated' as const, props: { entry } };
  }

  const query = await searchParams;
  const requested = await Promise.resolve(access.requestedProfile);
  const from = one(query.from);
  const to = one(query.to);
  const selectedPresetId = one(query.preset);
  const orgId = entry.context.active?.orgId ?? '';
  const profiles = await access.readSql((sql) => listProfiles({ sql }, orgId));
  const profile = access.selectProfile(profiles, requested);

  if (profile === null) {
    return { view: 'empty' as const, props: {} };
  }

  const profileToday = todayIsoInTimeZone(profile.timezone);
  const period = periodFromParamsThroughToday(
    {
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
    },
    profileToday,
  );

  const evidence = access.readSql(async (sql) => {
    const handle = { sql };
    const [rows, snapshot, latestJob] = await Promise.all([
      readCreativePerformance(handle, { orgId, profileId: profile.id, from: period.start, to: period.end }),
      readLatestCreativeSyncSnapshot(handle, { orgId, profileId: profile.id }),
      readLatestCreativeSyncJobState(handle, { orgId, profileId: profile.id }),
    ]);
    return { rows, snapshot, latestJob };
  });
  const rows = evidence.then((value) => value.rows);
  const pilot = creativeSyncPilotFromEnv();
  const producerEligible = profile.syncEnabled
    && pilot.enabled
    && pilot.profileIds.includes(profile.id.toLowerCase());
  const lifecycleEvidence = evidence.then(
    ({ snapshot, latestJob }): CreativeLifecycleEvidence => ({
      producerEligible,
      latestJob,
      snapshot,
    }),
  );

  return {
    view: 'ready' as const, props: {
      profile, period, profileToday, selectedPresetId, slot1: (<CreativeLifecycleStatus
        evidence={lifecycleEvidence}
        timezone={profile.timezone}
        profileId={profile.id}
      />), slot2: (<CreativeResults
        rows={rows}
        evidence={lifecycleEvidence}
        currencyCode={profile.currencyCode}
        profileId={profile.id}
      />)
    }
  };
}

type CreativeRows = Awaited<ReturnType<typeof readCreativePerformance>>;

async function CreativeLifecycleStatus(props: { evidence: Promise<CreativeLifecycleEvidence>; timezone: string; profileId: string; }) {
  return <CreativeLifecycleStatusView {...props} evidence={await props.evidence} />;
}

async function CreativeResults(props: { rows: Promise<CreativeRows>; evidence: Promise<CreativeLifecycleEvidence>; currencyCode: string; profileId: string; }) {
  const [rows, evidence] = await Promise.all([props.rows, props.evidence]);
  return <CreativeResultsView {...props} rows={rows} evidence={evidence} />;
}
