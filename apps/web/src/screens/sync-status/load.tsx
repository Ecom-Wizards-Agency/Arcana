import { readSpReportEvidence, readProviderEvidence, readStreamExtensionHealth, readCoreReportEvidence, loadReportLaneStatus } from '@wizard-ads/db';
import type { SpEvidence, StreamExtensionHealth } from '@wizard-ads/shared';
import type { ScreenActor } from '../../server/page-read';
import { CoreFeatureReportType } from '@wizard-ads/shared';
import type { ScreenParams } from '../types';
import { loadSyncStatus } from '../../data/sync-status';
import { listProfiles } from '../../../app/_lib/profiles';


/**
 * `/sync-status` — what the sync engine did, with operator-safe failure labels.
 *
 * Read-only and deliberately plain (WP-06 owns look and feel). Three tables:
 * freshness per profile, the job queue, the report ledger. Above them, the
 * report-lane banner (WP-323) names the stage that blocks new facts and the
 * bounded class of its last error. The report ledger
 * shows base-report parsed/loaded equality and attribution-aware
 * source/refused/promoted/unpromoted/canonical reconciliation, because "the
 * job succeeded" and "every source row was accounted for" are different
 * claims and only the second one is worth anything.
 */


interface Props {
  searchParams: Promise<{ profile?: string; }>;
}

export async function load(access: ScreenActor, input: ScreenParams) {
  const searchParams = Promise.resolve(input.searchParams) as Props['searchParams'];

  const query = await searchParams;
  const result = access.entry;

  if (result.state !== 'ok') {
    return { view: 'gated' as const, props: { result } };
  }

  const { context } = result;
  const org = context.active;
  if (!org) return null;

  const profiles = await access.read((handle) => listProfiles(handle, org.orgId));
  const selected = access.selectProfile(profiles, query.profile);
  const profileId = selected?.id ?? null;
  const status: Awaited<ReturnType<typeof loadSyncStatus>> & { streams?: StreamExtensionHealth[] } = await access.readSql((sql) => loadSyncStatus({ sql }, org.orgId, profileId));
  if (profileId) status.streams = await access.readSql((sql) => readStreamExtensionHealth({ sql }, org.orgId, profileId));
  const lane = await access.readSql((sql) => loadReportLaneStatus({ sql }, org.orgId, profileId));
  const today = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const coreEvidence = profileId ? await access.readSql((sql) => readCoreReportEvidence({ sql }, { orgId: org.orgId, profileId, families: CoreFeatureReportType.options, startDate: today, endDate: today, limit: 10 })) : [];
  const sources = profileId ? await access.readSql(sql => Promise.all((['retail', 'aba', 'catalogue'] as const).map(async family => ({ family, evidence: await readSpReportEvidence({ sql }, { orgId: org.orgId, profileId: profileId!, family, start: today, end: today, latest: true }) })))) : [];
  const providerEvidence = await access.readSql(async (sql) => Promise.all(status.freshness.map(async (profile) => ({ profileId: profile.profileId, evidence: await readProviderEvidence({ sql }, { orgId: org.orgId, profileId: profile.profileId, consumer: 'sync-status' }) }))));
  return { view: 'ready' as const, props: { ...(providerEvidence ? { providerEvidence } : {}), context, status, lane, ...(coreEvidence.length ? { coreEvidence } : {}), ...({ sources } as { sources?: { family: string; evidence: SpEvidence }[] }) } };
}
