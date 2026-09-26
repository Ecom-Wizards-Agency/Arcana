import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { createSpCreationBatchAdapter } from '@wizard-ads/ads-api';
import { getAdsRefreshToken, type DbHandle } from '@wizard-ads/db';
import { readSpWriteDatabaseTime } from '@wizard-ads/db/sp-write-worker';
import type { CampaignCreationBatch } from '@wizard-ads/shared';

export function createCampaignCreationProvider(database: DbHandle, env: NodeJS.ProcessEnv = process.env) {
  return async (batch: CampaignCreationBatch, signal: AbortSignal) => {
    signal.throwIfAborted();
    const clientId = env.LWA_CLIENT_ID ?? env.AMAZON_LWA_CLIENT_ID;
    const clientSecret = env['LWA_CLIENT_SECRET'] ?? env['AMAZON_LWA_CLIENT_SECRET'];
    const refreshToken = await getAdsRefreshToken(database, batch.plan.providerScope.connectionId);
    if (!clientId || !clientSecret || !refreshToken) throw new Error('Creation provider unavailable');
    const baseTime = Date.parse(await readSpWriteDatabaseTime(database));
    const started = performance.now();
    return createSpCreationBatchAdapter({ region: batch.plan.providerScope.region,
      credentials: { clientId, clientSecret, refreshToken },
      now: () => baseTime + Math.max(0, performance.now() - started),
      fetch: (input, init) => globalThis.fetch(input, init),
    }, { algorithm: 'sha256', digest: (text) => createHash('sha256').update(text).digest('hex') });
  };
}
