import { buildRestoreProposal, reviewRestoreProposal } from '@wizard-ads/db';
import { RestoreProposalRequest } from '@wizard-ads/shared';
import { authenticatedMutation, mutationBody, mutationUuid, MutationInputError } from '../../../../src/server/authenticated-mutation';
export const runtime='nodejs';
export async function POST(request:Request):Promise<Response> {
  return authenticatedMutation(request,async context=>{
    const body=await mutationBody(request);
    if('planId' in body) {
      const profileId=mutationUuid(body['profileId'],'profileId'),planId=mutationUuid(body['planId'],'planId');
      const fingerprint=body['fingerprint'];
      if(typeof fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(fingerprint)) throw new MutationInputError('Preview fingerprint required');
      await reviewRestoreProposal(context,{profileId,planId,fingerprint});
      return Response.json({planId});
    }
    const parsed=RestoreProposalRequest.safeParse(body);
    if(!parsed.success) throw new MutationInputError('A complete restore selection is required');
    const preview=await buildRestoreProposal(context,parsed.data);
    return Response.json({planId:preview.plan.id,rows:preview.plan.counts.providerRows});
  });
}
