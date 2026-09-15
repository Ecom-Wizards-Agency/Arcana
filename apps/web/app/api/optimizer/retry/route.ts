import { prepareOptimizerRetry } from '@wizard-ads/db';
import { OptimizerRetryRequest } from '@wizard-ads/shared/sp-write-application';
import { authenticatedMutation, mutationBody, MutationInputError } from '../../../../src/server/authenticated-mutation';
export const runtime = 'nodejs';
export function POST(request: Request) {
  return authenticatedMutation(request, async (context) => {
    const input = OptimizerRetryRequest.safeParse(await mutationBody(request));
    if (!input.success) throw new MutationInputError('The saved parent operation is required.');
    return Response.json(await prepareOptimizerRetry(context, input.data));
  }, (error) => {
    const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : null;
    return ['55000', '23505', 'source_changed', 'identity_conflict', 'unsupported_source'].includes(String(code))
      ? Response.json({ code: 'source_changed', error: 'This source cannot be retried. Changed values require a fresh evaluation; pending, successful and ambiguous rows stay excluded.' }, { status: 409 }) : null;
  });
}
