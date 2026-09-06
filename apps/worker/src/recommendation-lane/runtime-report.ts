import { RECOMMENDATION_EXECUTION_VERSIONS } from '@wizard-ads/shared';
import type { RecommendationWorkerDatabase } from '@wizard-ads/db/recommendation-worker';
import type { RecommendationClaimant } from './claimant.js';

/** Health uses its own connection so long input queries cannot starve readiness. */
export function startRecommendationRuntimeReporting(
  database: Pick<RecommendationWorkerDatabase, 'reportRuntime'>,
  claimant: Pick<RecommendationClaimant, 'status'>,
): { stop(): Promise<void> } {
  let stopped = false;
  let pending: Promise<void> | null = null;
  function report(): void {
    if (stopped || pending !== null) return;
    const state = claimant.status();
    pending = database.reportRuntime(RECOMMENDATION_EXECUTION_VERSIONS,
      state.ready && state.settlementFailure === null)
      // Database readiness expires independently if the worker cannot report.
      .catch(() => undefined)
      .finally(() => { pending = null; });
  }
  report();
  const timer = setInterval(report, 15_000);
  timer.unref();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await pending;
      await database.reportRuntime(RECOMMENDATION_EXECUTION_VERSIONS, false).catch(() => undefined);
    },
  };
}
