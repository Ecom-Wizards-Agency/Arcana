import { z } from 'zod';
import { DraftRouteData } from './campaign-builder.js';
import { CampaignCreationBatch } from './campaign-creation-batch.js';

/**
 * Creation review carries the recorded execution batch. The checks shown at confirmation are the
 * draft's persisted validation for the displayed revision: the same evidence admission binds.
 */
export const CampaignCreationDraftRouteData = z.union([
  DraftRouteData.options[0].extend({ creationBatch: CampaignCreationBatch.optional() }),
  DraftRouteData.options[1],
]);
export type CampaignCreationDraftRouteData = z.infer<typeof CampaignCreationDraftRouteData>;
