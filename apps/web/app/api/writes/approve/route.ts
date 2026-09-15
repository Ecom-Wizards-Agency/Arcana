import { approveSpWriteForActor } from '@wizard-ads/db/sp-write-application';
import { SpWriteConfirmedApprovalRequest } from '@wizard-ads/shared/sp-write-application';
import { handleSpWriteMutation } from '../../../../src/writes/http';

export const runtime = 'nodejs';
export const POST = (request: Request) => handleSpWriteMutation(request, SpWriteConfirmedApprovalRequest, approveSpWriteForActor);
