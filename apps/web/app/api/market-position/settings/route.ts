import { MarketPositionNotFound, saveMarketPositionSettings } from '@wizard-ads/db';
import { MarketPositionSettingsInput } from '@wizard-ads/shared';
import { authenticatedMutation, MutationInputError, mutationBody } from '../../../../src/server/authenticated-mutation';

export const runtime = 'nodejs';

export async function PUT(request: Request): Promise<Response> {
  return authenticatedMutation(request, async (context) => {
    const parsed = MarketPositionSettingsInput.safeParse(await mutationBody(request));
    if (!parsed.success) throw new MutationInputError('Enter a threshold from 0 to 100 percent and a valid profile.');
    return Response.json(await saveMarketPositionSettings(context, parsed.data));
  }, (error) => error instanceof MarketPositionNotFound
    ? Response.json({ error: 'Profile not found' }, { status: 404 }) : null);
}
