import { buildRestoreProposal, reviewRestoreProposal, readRestoreExportPreview, restoreProfileWriteEnabled } from '@wizard-ads/db';
import { RestoreProposalRequest } from '@wizard-ads/shared';
import { authenticatedMutation, mutationBody, mutationUuid, MutationInputError } from '../../../../src/server/authenticated-mutation';
import { requireCapability } from '../../../../src/server/org-role';
import { spWriteHttpFailure } from '../../../../src/writes/http';
export const runtime='nodejs';
export async function POST(request:Request):Promise<Response> {
  return authenticatedMutation(request,async context=>{
    await requireCapability(context,'exportBatches');
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
    if(!await restoreProfileWriteEnabled(context,parsed.data.profileId)) {
      const saved=await readRestoreExportPreview(context,{profileId:parsed.data.profileId,batchId:parsed.data.applyBatchId});
      const ready=saved.preview.rows.filter(row=>row.exportAllowed).map(row=>row.rowId).sort();
      if(JSON.stringify(ready)!==JSON.stringify([...parsed.data.sourceRowIds].sort())) throw new MutationInputError('Restore selection changed. Reload the preview.');
      return Response.json({kind:'export_only',batchId:saved.batchId,rows:saved.preview.readyRows});
    }
    const preview=await buildRestoreProposal(context,parsed.data);
    return Response.json({planId:preview.plan.id,rows:preview.plan.counts.providerRows});
  },error=>error instanceof MutationInputError?null:spWriteHttpFailure(error));
}
