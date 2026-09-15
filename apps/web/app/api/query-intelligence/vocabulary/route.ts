import { listQueryVocabularyForActor, mutateQueryVocabularyForActor, SqpPersistenceError } from '@wizard-ads/db';
import { QueryVocabularyMutation } from '@wizard-ads/shared';
import { authenticatedRead, readUuid } from '../../../../src/server/authenticated-read';
import { authenticatedMutation, mutationBody, MutationInputError } from '../../../../src/server/authenticated-mutation';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  return authenticatedRead(request, async context => {
    const entries = await listQueryVocabularyForActor(context, readUuid(new URL(request.url).searchParams.get('profileId'), 'profileId'));
    return Response.json({
      entries,
      count: entries.length
    });
  });
}
export async function POST(request: Request) {
  return authenticatedMutation(request, async context => {
    const parsed = QueryVocabularyMutation.safeParse(await mutationBody(request));
    if (!parsed.success) throw new MutationInputError('Check the vocabulary fields');
    return Response.json(await mutateQueryVocabularyForActor(context, parsed.data));
  }, error => error instanceof SqpPersistenceError ? Response.json({ error: error.message }, { status: 400 }) : null);
}
