import { listTargetTranslations, requestTargetTranslation } from '@wizard-ads/db';
import { TranslationLanguage, TranslationRequest } from '@wizard-ads/shared';
import { authenticatedRead, ApiReadError, readUuid } from '../../../src/server/authenticated-read';
import { authenticatedMutation, MutationInputError } from '../../../src/server/authenticated-mutation';
import { JsonMutationError, readJsonMutation } from '../../../src/server/json-mutation';
import { isUnambiguousExpression } from '../../../src/screens/grid/translation-column-scope';

export const runtime = 'nodejs';
export async function GET(request: Request): Promise<Response> {
  return authenticatedRead(request, async (snapshot) => {
    const params = new URL(request.url).searchParams;
    const language = TranslationLanguage.safeParse(params.get('language') ?? 'en');
    if (!language.success) throw new ApiReadError('Invalid translation language');
    const rows = await listTargetTranslations(snapshot, snapshot.actor.orgId, readUuid(params.get('profile'), 'profile'), language.data);
    return Response.json({ rows, count: rows.length });
  });
}
export async function POST(request: Request): Promise<Response> {
  return authenticatedMutation(request, async (context) => {
    const input = TranslationRequest.safeParse(await readJsonMutation(request));
    if (!input.success) throw new MutationInputError('Invalid translation request');
    // Text alone cannot prove a keyword, so only text that can never be one is refused before anything is queued.
    if (isUnambiguousExpression(input.data.originalText)) throw new MutationInputError('Only keyword phrases are translated');
    const row = await requestTargetTranslation(context, input.data);
    return Response.json({ row, count: 1 });
  }, (error) => error instanceof JsonMutationError ? Response.json({ error: error.code }, { status: error.status }) : null);
}
