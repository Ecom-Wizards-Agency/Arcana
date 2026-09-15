import { exportOptimizerSelection } from '@wizard-ads/db';
import { OptimizerSelectionExportRequest } from '@wizard-ads/shared';
import { authenticatedMutation, mutationBody, MutationInputError } from '../../../../src/server/authenticated-mutation';
export const runtime = 'nodejs';
export function POST(request: Request) {
  return authenticatedMutation(request, async (context) => {
    const input = OptimizerSelectionExportRequest.safeParse(await mutationBody(request));
    if (!input.success) throw new MutationInputError('The exact saved selection is required.');
    return Response.json(await exportOptimizerSelection(context, input.data));
  }, (error) => {
    const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : null;
    return ['55000', '23505', 'source_changed', 'identity_conflict'].includes(String(code))
      ? Response.json({ code: 'source_changed', error: 'The saved selection or current values changed. Refresh the review before continuing.' }, { status: 409 }) : null;
  });
}
