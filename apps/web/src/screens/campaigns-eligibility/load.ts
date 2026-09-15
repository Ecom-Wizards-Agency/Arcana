import { readCampaignRouteFixture, BuilderRouteData } from '../../campaigns/route-fixtures';
import { load as builderLoad } from '../campaigns/load';
import type { ScreenActor } from '../../server/page-read';
import type { ScreenParams } from '../types';
export async function load(access: ScreenActor, input: ScreenParams) {
  const fixture = await readCampaignRouteFixture(access, input, 'campaigns-eligibility', BuilderRouteData);
  return fixture ?? builderLoad(access, input);
}
