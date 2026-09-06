import { RecommendationPreviewAccepted, RecommendationPreviewBatchStatus } from '@wizard-ads/shared';
export type { RecommendationPreviewAccepted as OptimizerPreviewAccepted, RecommendationPreviewBatchStatus as OptimizerPreviewBatchStatus, RecommendationPreviewChildStatus as OptimizerPreviewChildStatus, RecommendationPreviewStatus as OptimizerPreviewStatus } from '@wizard-ads/shared';
import type { OneTimeRpcBidSettings } from '@wizard-ads/shared';
import type { OptimizationGroupRecord } from '@wizard-ads/db';
import type { OptimizerCampaignFactRow } from '../../app/_lib/optimizer-campaigns';
import type { ProposalView } from '../recommendations/view';

export interface OptimizerCampaignRow extends OptimizerCampaignFactRow {
  eligibilityReason: string | null;
  groupName: string | null;
  groupRole: string | null;
  lastRunAt: string | null;
  proposals: number;
  selectable: boolean;
  oneTimeSettings?: Partial<OneTimeRpcBidSettings> | null;
}

export function buildOptimizerCampaignRows(
  facts: readonly OptimizerCampaignFactRow[],
  groups: readonly OptimizationGroupRecord[],
  proposals: readonly ProposalView[],
  oneTime = false,
): OptimizerCampaignRow[] {
  const groupById = new Map(groups.map((record) => [record.group.id, record]));
  const proposalCounts = new Map<string, number>();
  for (const proposal of proposals) {
    if (proposal.campaignId === null) continue;
    proposalCounts.set(proposal.campaignId, (proposalCounts.get(proposal.campaignId) ?? 0) + 1);
  }

  return facts.map((campaign) => {
    const record = campaign.groupId === null ? undefined : groupById.get(campaign.groupId);
    const eligibilityReason = campaignEligibilityReason(campaign, record, oneTime);
    return {
      ...campaign,
      eligibilityReason,
      groupName: record?.group.name ?? null,
      groupRole: record?.group.role ?? null,
      lastRunAt: record?.lastRun?.createdAt ?? null,
      proposals: proposalCounts.get(campaign.campaignId) ?? 0,
      selectable: eligibilityReason === null,
      ...(oneTime ? { oneTimeSettings: record === undefined ? null : {
        targetAcos: record.group.targetAcos, bidFloor: record.group.bidFloor ?? undefined, bidCeiling: record.group.bidCeiling ?? undefined,
        bidIncreaseCap: record.group.bidIncreaseCap, bidDecreaseCap: record.group.bidDecreaseCap,
      } } : {}),
    };
  });
}

function campaignEligibilityReason(
  campaign: OptimizerCampaignFactRow,
  record: OptimizationGroupRecord | undefined,
  oneTime: boolean,
): string | null {
  if (campaign.state !== 'enabled') return `Campaign state is ${displayState(campaign.state)}.`;
  if (campaign.adProduct !== 'SP') return 'Only Sponsored Products campaigns support bid previews.';
  if (campaign.groupId !== null && record === undefined) {
    return 'The assigned optimization group is unavailable.';
  }
  if (!oneTime && record !== undefined && !record.group.enabled) return 'The assigned optimization group is disabled.';
  return null;
}

function displayState(value: string): string {
  return value.replaceAll('_', ' ').toLocaleLowerCase();
}

export function filterOptimizerCampaignRows(
  rows: readonly OptimizerCampaignRow[],
  input: { query: string; group: string; state: string },
): OptimizerCampaignRow[] {
  const query = input.query.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    if (query !== '' && !`${row.name} ${row.campaignId} ${row.adProduct}`.toLocaleLowerCase().includes(query)) {
      return false;
    }
    if (input.group === 'unassigned' && row.groupId !== null) return false;
    if (input.group !== 'all' && input.group !== 'unassigned' && row.groupId !== input.group) return false;
    if (input.state !== 'all' && row.state !== input.state) return false;
    return true;
  });
}

export function parseOptimizerPreviewAccepted(input: unknown): RecommendationPreviewAccepted {
  const parsed = RecommendationPreviewAccepted.safeParse(input);
  if (!parsed.success) throw new Error('The preview service returned an invalid acceptance response.');
  return parsed.data;
}

export function parseOptimizerPreviewStatus(input: unknown): RecommendationPreviewBatchStatus {
  const parsed = RecommendationPreviewBatchStatus.safeParse(input);
  if (!parsed.success) throw new Error('The preview service returned an invalid status response.');
  return parsed.data;
}

export function optimizerPreviewError(input: unknown, fallback: string): string {
  return isObject(input) && typeof input.error === 'string' && input.error.trim() !== ''
    ? input.error
    : fallback;
}

function isObject(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null;
}
