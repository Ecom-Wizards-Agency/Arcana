import { withAuthenticatedReadSnapshot } from '@wizard-ads/db';
import { readRecordedSpWritePreviewForActor } from '@wizard-ads/db/sp-write-application';
import {
  SpWriteRecordedPreviewRequest,
  type SpWriteRecordedPreview,
} from '@wizard-ads/shared/sp-write-application';
import { requireCapability } from '../server/org-role';
import { openWebDatabase, requestActor } from '../server/request-context';

/** Server page input: request headers establish authority, never client actor IDs. */
export async function loadSpWriteApproval(
  headers: Headers,
  input: SpWriteRecordedPreviewRequest,
): Promise<SpWriteRecordedPreview> {
  const actor = await requestActor(headers);
  const request = SpWriteRecordedPreviewRequest.parse(input);
  const database = openWebDatabase();
  try {
    return await withAuthenticatedReadSnapshot(database, actor, async (context) => {
      await requireCapability(context, 'exportBatches');
      return readRecordedSpWritePreviewForActor(context, request);
    });
  } finally {
    await database.close();
  }
}
