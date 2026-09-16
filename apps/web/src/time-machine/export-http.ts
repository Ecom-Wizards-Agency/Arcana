import { exportRestoreProposalForActor, readRestoreExportPreview } from '@wizard-ads/db';
import { SpWriteRestoreExportRequest, SpWriteRestoreExportResult } from '@wizard-ads/shared/sp-write-application';
import { authenticatedMutation, mutationBody, MutationInputError } from '../server/authenticated-mutation';
import { requireCapability } from '../server/org-role';
import { exportFilenames } from '../recommendations/export';
import { reversionBatchTag } from './reversion';
import { spWriteHttpFailure } from '../writes/http';

export function handleRestoreExport(request:Request, legacy=false):Promise<Response> {
  return authenticatedMutation(request,async context=>{
    await requireCapability(context,'exportBatches');
    let body=await mutationBody(request);
    if(legacy && body['confirmation']==='Yes, export reversion'
      && typeof body['profileId']==='string' && typeof body['batchId']==='string'
      && Number.isInteger(body['expectedRows']) && Number(body['expectedRows'])>0) {
      const saved=await readRestoreExportPreview(context,{profileId:body['profileId'],batchId:body['batchId']});
      body={...body,fingerprint:saved.fingerprint,confirmation:`Export restore proposal (${String(body['expectedRows'])} changes)`};
    }
    const parsed=SpWriteRestoreExportRequest.safeParse(body);
    if(!parsed.success) throw new MutationInputError('Confirmation, count, note and the exact restore preview fingerprint are required.');
    const input=parsed.data;
    const saved=await readRestoreExportPreview(context,input);
    if(saved.preview.readyRows!==input.expectedRows) throw new MutationInputError(
      `Reversion changed since preview: expected ${input.expectedRows} rows, now ${saved.preview.readyRows} are ready. Review it again.`);
    const result=await exportRestoreProposalForActor(context,input,reversionBatchTag({
      sourceTag:saved.preview.tag,sourceBatchId:input.batchId,exportedAt:new Date(),
    }));
    const files=exportFilenames(result.tag);
    return Response.json(SpWriteRestoreExportResult.parse({
      batchId:result.batchId,sourceBatchId:result.sourceBatchId,tag:result.tag,rows:result.rows.length,
      artifactSha256:result.artifactSha256,files:{rows:files.rows},
      downloads:{rows:`/api/recommendations/export/${result.batchId}?format=rows`},
      amazonUpdated:false,guardrail:'This is a review file only. Arcana did not update Amazon.',
    }),{status:201});
  },error=>error instanceof MutationInputError?null:spWriteHttpFailure(error));
}
