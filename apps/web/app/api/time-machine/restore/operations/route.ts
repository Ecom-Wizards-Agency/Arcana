import { assertRestoreBatchBinding, readRestoreOperation } from '@wizard-ads/db';
import { Uuid } from '@wizard-ads/shared';
import { SpWriteOperationRequest } from '@wizard-ads/shared/sp-write-application';
import { authenticatedRead, ApiReadError } from '../../../../../src/server/authenticated-read';
import { requireCapability } from '../../../../../src/server/org-role';

export const runtime='nodejs';
export function GET(request:Request) {
  return authenticatedRead(request,async context=>{
    await requireCapability(context,'exportBatches');
    const query=new URL(request.url).searchParams;
    if([...query.keys()].length!==new Set(query.keys()).size) throw new ApiReadError('Duplicate parameters');
    const batchId=Uuid.safeParse(query.get('batchId'));
    query.delete('batchId');
    const input=SpWriteOperationRequest.safeParse(Object.fromEntries(query));
    if(!input.success||!batchId.success) throw new ApiReadError('Invalid saved restore identity');
    await assertRestoreBatchBinding(context,{orgId:context.actor.orgId,profileId:input.data.profileId,batchId:batchId.data,planId:input.data.planId});
    return Response.json(await readRestoreOperation(context,input.data));
  });
}
