import { z } from 'zod';
import { CampaignBuilderCheck, CampaignBuilderValidation } from './campaign-builder.js';

/** Listing checks remain truthful unknowns; every runnable check must pass. */
export const CampaignCreationAdmissionValidation = z.object(CampaignBuilderValidation.shape).strict().superRefine((value, ctx) => {
  const ids = CampaignBuilderCheck.shape.id.options;
  if (value.checks.length !== ids.length || new Set(value.checks.map((check) => check.id)).size !== ids.length
    || ids.some((id) => !value.checks.some((check) => check.id === id))
    || value.checks.some((check) => check.blocking || check.status === 'blocked'
      || (check.status === 'not_measured' && !['stock', 'buy-box', 'suppression', 'moderation'].includes(check.id)))) {
    ctx.addIssue({ code: 'custom', message: 'Every creation check must occur exactly once; runnable checks must pass' });
  }
});
export type CampaignCreationAdmissionValidation = z.infer<typeof CampaignCreationAdmissionValidation>;

/** A queued creation cannot outlive the current review checks that authorized it. */
export const CAMPAIGN_CREATION_REVIEW_TTL_MS = 300_000;
export function campaignCreationReviewExpiresAt(planExpiresAt: string, checkedAt: string): string {
  return new Date(Math.min(Date.parse(planExpiresAt), Date.parse(checkedAt) + CAMPAIGN_CREATION_REVIEW_TTL_MS)).toISOString();
}
