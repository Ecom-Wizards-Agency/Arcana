import { readSpWriteOperationForActor } from '@wizard-ads/db/sp-write-application';
import { SpWriteOperationRequest } from '@wizard-ads/shared/sp-write-application';
import { handleSpWriteRead } from '../../../../src/writes/http';

export const runtime = 'nodejs';
export const GET = (request: Request) => handleSpWriteRead(request, SpWriteOperationRequest, readSpWriteOperationForActor);
