import { readSpReportEvidence } from '@wizard-ads/db';
import type { SpEvidence } from '@wizard-ads/shared';
import { readProviderEvidence } from '@wizard-ads/db';
import type { ScreenActor } from '../../server/page-read';
import { readCoreReportEvidence } from '@wizard-ads/db';
import { CoreFeatureReportType } from '@wizard-ads/shared';

import type { ScreenParams } from '../types';

/**
 * `/sync-status` — what the sync engine did, with operator-safe failure labels.
 *
 * Read-only and deliberately plain (WP-06 owns look and feel). Three tables:
 * freshness per profile, the job queue, the report ledger. The report ledger
 * shows base-report parsed/loaded equality and attribution-aware
 * source/refused/promoted/unpromoted/canonical reconciliation, because "the
 * job succeeded" and "every source row was accounted for" are different
 * claims and only the second one is worth anything.
 */

import { loadSyncStatus } from '../../data/sync-status';
import { listProfiles } from '../../../app/_lib/profiles';

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
  const status = await access.readSql((sql) => loadSyncStatus({ sql }, org.orgId, profileId));
  const today = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const coreEvidence = profileId ? await access.readSql((sql) => readCoreReportEvidence({ sql }, { orgId: org.orgId, profileId, families: CoreFeatureReportType.options, startDate: today, endDate: today, limit: 10 })) : [];
  const sources = profileId ? await access.readSql(sql => Promise.all((['retail', 'aba', 'catalogue'] as const).map(async family => ({ family, evidence: await readSpReportEvidence({ sql }, { orgId: org.orgId, profileId: profileId!, family, start: today, end: today, latest: true }) })))) : [];
  const providerEvidence = await access.readSql(async (sql) => Promise.all(status.freshness.map(async (profile) => ({ profileId: profile.profileId, evidence: await readProviderEvidence({ sql }, { orgId: org.orgId, profileId: profile.profileId, consumer: 'sync-status' }) }))));
  return { view: 'ready' as const, props: { ...(providerEvidence ? { providerEvidence } : {}), context, status, ...(coreEvidence.length ? { coreEvidence } : {}), ...({ sources } as { sources?: { family: string; evidence: SpEvidence }[] }) } };
}
