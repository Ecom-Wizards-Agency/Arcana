import { reconcileStreamExtensionWork, reconcileAssetRegistrations, reconcileAssetSearchWork,
  type DbHandle } from '@wizard-ads/db';
import { EvidenceReconciliationCounts } from '@wizard-ads/shared';

/** Called before the first claim. Explicit off gates produce no database or provider call. */
export async function reconcileEvidenceOnWorkerStart(handle: Pick<DbHandle, 'sql'>, policy: {
  streamEnabled: boolean; assetEnabled: boolean;
}) {
  const stream = await reconcileStreamExtensionWork(handle, policy.streamEnabled);
  const writes = await reconcileAssetRegistrations(handle, policy.assetEnabled);
  const search = await reconcileAssetSearchWork(handle, policy.assetEnabled);
  return { stream: EvidenceReconciliationCounts.parse(stream), assets: EvidenceReconciliationCounts.parse({
    requested: writes.requested+search.requested, attempted: writes.attempted+search.attempted,
    succeeded: writes.succeeded+search.succeeded, failed: writes.failed+search.failed, refused: writes.refused+search.refused,
  }) };
}

export class EvidenceRetryPendingError extends Error {
  constructor(readonly retryAfterSeconds: number) { super('Evidence retry is not due'); }
}

/** Opt-in bounded recovery passes; no event/report schedule and no provider client. */
export function startEvidenceReconciliation(run: () => Promise<unknown>, onError: () => void, intervalMs = 60_000) {
  let active: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (active) return;
    active = run().then(() => {}, onError).finally(() => { active = null; });
  }, intervalMs);
  timer.unref();
  return { stop: async () => { clearInterval(timer); await active; } };
}
