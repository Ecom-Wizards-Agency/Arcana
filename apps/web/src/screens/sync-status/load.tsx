import { readStreamExtensionHealth } from '@wizard-ads/db';
import type { StreamExtensionHealth } from '@wizard-ads/shared';
import type { ScreenActor } from '../../server/page-read';

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

  const status: Awaited<ReturnType<typeof loadSyncStatus>> & { streams?: StreamExtensionHealth[] } = await access.readSql((sql) => loadSyncStatus({ sql }, org.orgId, query.profile ?? null));

  if (query.profile) status.streams = await access.readSql((sql) => readStreamExtensionHealth({ sql }, org.orgId, query.profile!));

  return { view: 'ready' as const, props: { context, status } };
}
