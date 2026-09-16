import { z } from 'zod';
import { DraftRouteData } from './campaign-builder.js';
import { CampaignCreationBatch } from './campaign-creation-batch.js';
import { CampaignCreationAdmissionValidation } from './campaign-creation-admission.js';

/** Creation review preserves unmeasured listing checks and carries the recorded execution batch. */
export const CampaignCreationDraftRouteData = z.union([
  DraftRouteData.options[0].extend({ creationBatch: CampaignCreationBatch.optional(), creationValidation: CampaignCreationAdmissionValidation.optional() }),
  DraftRouteData.options[1],
]);
export type CampaignCreationDraftRouteData = z.infer<typeof CampaignCreationDraftRouteData>;
