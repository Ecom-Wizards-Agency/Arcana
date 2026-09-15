import { readSponsoredPrompts, SponsoredPromptInputError } from '@wizard-ads/db';
import { authenticatedRead, readUuid } from '../../../src/server/authenticated-read';
import { screenEnabled } from '../../../src/screens/types';
import { descriptor } from '../../../src/screens/sponsored-prompts/descriptor';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  return authenticatedRead(request, async (database, actor) => {
    if (!screenEnabled(descriptor)) return Response.json({ error: 'Sponsored prompts is not enabled' }, { status: 404 });
    const profileId = new URL(request.url).searchParams.get('profile') ?? ''; readUuid(profileId, 'profile');
    try { return Response.json(await readSponsoredPrompts(database, { ...actor, profileId })); }
    catch (error) { if (error instanceof SponsoredPromptInputError) return Response.json({ error: error.message }, { status: 404 }); throw error; }
  });
}
