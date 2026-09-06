import { previewSpWrite, readRecordedSpWritePreview } from '@wizard-ads/db/sp-write-application';
import { SpWritePreviewRequest, SpWriteRecordedPreviewRequest } from '@wizard-ads/shared/sp-write-application';
import { handleSpWriteRequest } from '../../../../src/writes/http';

export const runtime = 'nodejs';
export const POST = (request: Request): Promise<Response> =>
  handleSpWriteRequest(request, SpWritePreviewRequest, previewSpWrite);

/** Reload recorded evidence only; GET never freezes or approves a new plan. */
export const GET = (request: Request): Promise<Response> =>
  handleSpWriteRequest(request, SpWriteRecordedPreviewRequest, readRecordedSpWritePreview);
