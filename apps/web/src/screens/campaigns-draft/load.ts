import { readCampaignRouteFixture } from '../../campaigns/route-fixtures';
import { readCampaignDraft, readCampaignCreationGate, readCampaignCreationBatch, readCampaignCreationProviderScope } from '@wizard-ads/db';
import { Uuid, CampaignCreationDraftRouteData } from '@wizard-ads/shared';
import { revalidateCreationDraft } from '../../campaigns/creation-approval';
import { CampaignCreationAdmissionValidation } from '@wizard-ads/shared';
import { savedCampaignCreationReview } from '../../campaigns/review';
import type { ScreenActor } from '../../server/page-read';
import type { ScreenParams } from '../types';
import { loadCampaignBuilderContext } from '../../campaigns/data';
import { unstable_rethrow } from 'next/navigation';
import { pageReadErrorMessage } from '../../server/authenticated-page-read';
import { listProfiles } from '../../../app/_lib/profiles';

export type DraftScreenData = CampaignCreationDraftRouteData;
export async function load(access: ScreenActor, input: ScreenParams): Promise<DraftScreenData> {
  const id = Uuid.safeParse(input.searchParams['draft']);
  const fixture = await readCampaignRouteFixture(access, input, 'campaigns-draft', CampaignCreationDraftRouteData);
  if (fixture) return fixture;
  try {
    return await access.snapshot(async (snapshot) => {
      const profile = access.selectProfile(await listProfiles({ sql: snapshot.sql }, snapshot.actor.orgId));
      if (!profile || !id.success) return { view: 'empty', message: 'Save a campaign draft before reviewing it.' };
      const draft = await readCampaignDraft(snapshot, profile.id, id.data);
      if (!draft) return { view: 'empty', message: 'This draft is unavailable to the current operator.' };
      const context = await loadCampaignBuilderContext(snapshot, profile.id);
      const gate = await readCampaignCreationGate(snapshot, draft.plan);
      const batchId = Uuid.safeParse(input.searchParams['batch']);
      const batch = batchId.success ? await readCampaignCreationBatch(snapshot, profile.id, batchId.data) : null;
      const currentValidation = draft.status === 'approved' && batch?.draftId === draft.id
        ? await revalidateCreationDraft(snapshot, draft, context, batch) : null;
      const creationValidation = currentValidation ? CampaignCreationAdmissionValidation.safeParse(currentValidation) : null;
      const reviewDraft = currentValidation ? { ...draft, validation: currentValidation } : draft;
      const review = savedCampaignCreationReview(reviewDraft, context.profile.label, new Date().toISOString(), await readCampaignCreationProviderScope(snapshot, profile.id));
      return { view: 'ready', context, draft, review, executorAvailable: gate.available,
        ...(creationValidation?.success ? { creationValidation: creationValidation.data } : {}),
        ...(batch?.draftId === draft.id ? { creationBatch: batch } : {}),
        step: typeof input.searchParams['step'] === 'string' ? input.searchParams['step'] : 'review' };
    });
  } catch (error) { unstable_rethrow(error); return { view: 'error', message: pageReadErrorMessage(error, 'The campaign draft is unavailable.') }; }
}
