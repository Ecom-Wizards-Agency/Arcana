import { recordSponsoredPromptVisit, SponsoredPromptInputError } from '@wizard-ads/db';
import { SponsoredPromptVisit } from '@wizard-ads/shared';
import { authenticatedMutation, mutationBody, MutationInputError } from '../../../../src/server/authenticated-mutation';
import { screenEnabled } from '../../../../src/screens/types';
import { descriptor } from '../../../../src/screens/sponsored-prompts/descriptor';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  return authenticatedMutation(request, async (context) => {
    if (!screenEnabled(descriptor)) return Response.json({ error: 'Sponsored prompts is not enabled' }, { status: 404 });
    const input = SponsoredPromptVisit.safeParse(await mutationBody(request));
    if (!input.success) throw new MutationInputError('Check the visit marker');
    return Response.json(await recordSponsoredPromptVisit(context, input.data));
  }, (error) => error instanceof SponsoredPromptInputError ? Response.json({ error: error.message }, { status: 404 }) : null);
}
