import { previewSpWriteForActor, readRecordedSpWritePreviewForActor } from '@wizard-ads/db/sp-write-application';
import { SpWritePreviewRequest, SpWriteRecordedPreviewRequest } from '@wizard-ads/shared/sp-write-application';
import { handleSpWriteMutation, handleSpWriteRead } from '../../../../src/writes/http';

export const runtime = 'nodejs';
export const POST = (request: Request) => handleSpWriteMutation(request, SpWritePreviewRequest, previewSpWriteForActor);
export const GET = (request: Request) => handleSpWriteRead(request, SpWriteRecordedPreviewRequest, readRecordedSpWritePreviewForActor);
