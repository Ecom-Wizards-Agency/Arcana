import type { OneTimePreviewUnavailableReason } from '@wizard-ads/shared';

const ONE_TIME_MESSAGES: Record<OneTimePreviewUnavailableReason, string> = {
  misconfigured: 'One-time previews are not configured correctly. Ask the installation operator to check the recommendation worker.',
  worker_not_activated: 'One-time previews are awaiting activation of the compatible recommendation worker.',
  admission_paused: 'New previews are paused by the installation operator. Existing runs remain available.',
  revision_mismatch: 'The web application and recommendation worker are awaiting a compatible release. Try again after the release completes.',
  worker_unavailable: 'The recommendation worker is unavailable. Try again when it reconnects; existing previews remain saved.',
  execution_unsupported: 'The installed worker needs an update before it can run one-time previews.',
  authority_unavailable: 'Worker readiness could not be checked. Refresh and try again.',
};
export function oneTimePreviewUnavailableMessage(reason: OneTimePreviewUnavailableReason): string {
  return ONE_TIME_MESSAGES[reason];
}
