import { readCampaignDraft } from '@wizard-ads/db';
import { Uuid, campaignCreationExecutorAvailable, type CampaignBuilderContext, type CampaignDraft } from '@wizard-ads/shared';
import type { CampaignCreationApprovalView } from '@wizard-ads/shared/campaign-creation-approval';
import { unavailableCampaignReview } from '../../campaigns/review';
import type { ScreenActor } from '../../server/page-read';
import type { ScreenParams } from '../types';
import { loadCampaignBuilderContext } from '../../campaigns/data';
import { unstable_rethrow } from 'next/navigation';
import { pageReadErrorMessage } from '../../server/authenticated-page-read';
import { listProfiles } from '../../../app/_lib/profiles';

export type DraftScreenData = { view: 'ready'; context: CampaignBuilderContext; draft: CampaignDraft; review: CampaignCreationApprovalView; executorAvailable: boolean; step: string }
  | { view: 'error' | 'empty' | 'gated' | 'not-measured'; message: string };
export async function load(access: ScreenActor, input: ScreenParams): Promise<DraftScreenData> {
  const id = Uuid.safeParse(input.searchParams['draft']);
  try {
    return await access.snapshot(async (snapshot) => {
      const profile = access.selectProfile(await listProfiles({ sql: snapshot.sql }, snapshot.actor.orgId));
      if (!profile || !id.success) return { view: 'empty', message: 'Save a campaign draft before reviewing it.' };
      const draft = await readCampaignDraft(snapshot, profile.id, id.data);
      if (!draft) return { view: 'empty', message: 'This draft is unavailable to the current operator.' };
      const context = await loadCampaignBuilderContext(snapshot, profile.id);
      const review = unavailableCampaignReview(draft, context.profile.label, new Date().toISOString());
      return { view: 'ready', context, draft, review, executorAvailable: campaignCreationExecutorAvailable(process.env), step: typeof input.searchParams['step'] === 'string' ? input.searchParams['step'] : 'review' };
    });
  } catch (error) { unstable_rethrow(error); return { view: 'error', message: pageReadErrorMessage(error, 'The campaign draft is unavailable.') }; }
}
