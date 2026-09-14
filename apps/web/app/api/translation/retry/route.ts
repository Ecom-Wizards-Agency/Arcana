import { retryTargetTranslation } from '@wizard-ads/db';
import { TranslationRetry } from '@wizard-ads/shared';
import { authenticatedMutation, MutationInputError } from '../../../../src/server/authenticated-mutation';
import { JsonMutationError, readJsonMutation } from '../../../../src/server/json-mutation';

export const runtime = 'nodejs';
export async function POST(request: Request): Promise<Response> {
  return authenticatedMutation(request, async (context) => {
    const input = TranslationRetry.safeParse(await readJsonMutation(request));
    if (!input.success) throw new MutationInputError('Invalid translation retry');
    return Response.json({ row: await retryTargetTranslation(context, input.data), count: 1 });
  }, (error) => error instanceof JsonMutationError ? Response.json({ error: error.code }, { status: error.status }) : null);
}
