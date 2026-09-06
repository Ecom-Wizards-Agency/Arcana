import { RecommendationPreviewDiagnostics, type RecommendationPreviewChildStatus } from '@wizard-ads/shared';

/** Translate persisted counts into operator guidance without returning raw worker errors. */
export function previewResultDetails(
  status: RecommendationPreviewChildStatus['status'],
  proposalsCount: number,
  narrative: unknown,
): Pick<RecommendationPreviewChildStatus, 'outcome' | 'detail' | 'diagnostics'> {
  if (status === 'queued') return { outcome: 'queued', detail: 'Waiting for the recommendation worker.' };
  if (status === 'running') return { outcome: 'running', detail: 'The worker is evaluating the confirmed campaign scope.' };
  if (status === 'failed') return { outcome: 'failed', detail: 'This run failed. Completed runs remain available; refresh the status before retrying.' };
  const record = typeof narrative === 'object' && narrative !== null ? narrative as Record<string, unknown> : {};
  const parsed = RecommendationPreviewDiagnostics.safeParse(record['diagnostics']);
  const diagnostics = parsed.success ? parsed.data : undefined;
  const safety = record['groupSafety'];
  const held = typeof safety === 'object' && safety !== null && 'mayPropose' in safety && safety.mayPropose === false;
  const detail = proposalsCount > 0
    ? `${proposalsCount} proposed bid changes are ready to review.`
    : held
      ? 'Earlier exported changes are awaiting observation or reversion review. Review that history before another preview.'
      : diagnostics === undefined
        ? 'No changes were recommended. Detailed counts are unavailable for this historical run.'
        : diagnostics.targetsRead === 0
          ? 'No target reports are available for the confirmed period. Check reporting freshness and the selected dates.'
          : diagnostics.skippedInactive === diagnostics.targetsRead
            ? 'The reported targets, ad groups, or campaigns are not enabled in the synchronized account. Synchronize and review their states.'
            : diagnostics.skippedMissingStrategy > 0
              ? 'Targets were skipped because saved strategy settings were missing. Run a one-time preview with explicit settings.'
              : diagnostics.blockedOutOfStock > 0
                ? 'Stock safeguards blocked targets. Review availability before changing their bids.'
                : (diagnostics.declinedReasons['explicit_limits_conflict'] ?? 0) > 0
                  ? 'The calculated bids could not satisfy all confirmed limits. Review the minimum, maximum, and change caps.'
                  : 'No target met the RPC change criteria within the confirmed limits. Review the reporting period and calculation counts.';
  return { outcome: proposalsCount > 0 ? 'completed' : 'empty', detail, ...(diagnostics === undefined ? {} : { diagnostics }) };
}
