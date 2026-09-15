import { assertOptimizerApplyBatch, readOptimizerOperation } from '@wizard-ads/db';
import { Uuid } from '@wizard-ads/shared';
import { SpWriteOperationRequest } from '@wizard-ads/shared/sp-write-application';
import { authenticatedRead, ApiReadError } from '../../../../src/server/authenticated-read';
export const runtime = 'nodejs';
export function GET(request: Request) {
  return authenticatedRead(request, async (context) => {
    const query = new URL(request.url).searchParams;
    if ([...query.keys()].length !== new Set(query.keys()).size) throw new ApiReadError('Duplicate parameters');
    const batch = Uuid.safeParse(query.get('batchId'));
    query.delete('batchId');
    const input = SpWriteOperationRequest.safeParse(Object.fromEntries(query));
    if (!input.success || !batch.success) throw new ApiReadError('Invalid saved operation identity');
    const operation = await readOptimizerOperation(context, input.data);
    const source = operation.plan.source;
    if (source.kind !== 'apply_batch') throw new ApiReadError('This operation is not an optimizer proposal');
    await assertOptimizerApplyBatch(context, { orgId: context.actor.orgId, profileId: input.data.profileId, batchId: batch.data, applyBatchId: source.applyBatchId });
    return Response.json(operation);
  });
}
