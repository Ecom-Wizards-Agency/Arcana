import type { CampaignBuilderCheck } from '@wizard-ads/shared';
import { DetailsTable, Notice } from '../campaigns/ui';
export function EligibilityChecks({ checks }: { checks: CampaignBuilderCheck[] }) {
  return <><DetailsTable headings={['Check', 'What it prevents', 'Can we run it', 'Where it comes from']} rows={checks.map((check) => [check.label,
    check.requiredAction || 'Checked for this draft', check.status === 'not_measured' ? 'Not measured' : check.status === 'passed' ? 'Yes · Passed' : 'Yes · Blocked', check.source])} />
    <Notice>A check we cannot run is shown as unavailable, never as passed. Listing and moderation checks remain not measured and are listed at confirmation.</Notice></>;
}
