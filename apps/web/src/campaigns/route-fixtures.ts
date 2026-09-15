/** Server-only fixture source. No table or provider fixture exists in production. */
import { Uuid, BuilderRouteData, DraftRouteData, NamingRouteData, AssetsRouteData, UpdateRouteData } from '@wizard-ads/shared';
export { BuilderRouteData, DraftRouteData, NamingRouteData, AssetsRouteData, UpdateRouteData };
import { e2eAuthEnabled } from '../auth/session';
import { listProfiles } from '../../app/_lib/profiles';
import type { ScreenActor } from '../server/page-read';
import type { ScreenParams } from '../screens/types';

export function campaignRouteFixturesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['NODE_ENV'] === 'production' || env['WIZARD_ADS_E2E_AUTH'] !== '1') return false;
  const url = env['DATABASE_URL'];
  if (!url) return false;
  try { const parsed = new URL(url); return ['localhost', '127.0.0.1'].includes(parsed.hostname) && parsed.pathname === '/wizard_ads_e2e' && e2eAuthEnabled(env); }
  catch { return false; }
}
/** Normal routes and views are unchanged; only the signed-in local fixture server
 * can read these actor/profile-bound records. Query strings never carry payloads. */
export async function readCampaignRouteFixture<T>(access: ScreenActor, input: ScreenParams, screen: string, schema: { parse: (raw: unknown) => T }): Promise<T | null> {
  if (!campaignRouteFixturesEnabled()) return null;
  const id = Uuid.safeParse(input.searchParams['fixture']);
  if (!id.success) return null;
  const record = await access.snapshot(async (snapshot) => {
    const profile = access.selectProfile(await listProfiles({ sql: snapshot.sql }, snapshot.actor.orgId));
    if (!profile) throw new Error('Fixture profile unavailable');
    const rows = await snapshot.sql<{ mode: string; payload: unknown }[]>`select mode,payload from public.campaign_screen_fixtures where id=${id.data}::uuid and org_id=${snapshot.actor.orgId}::uuid and created_by=${snapshot.actor.userId}::uuid and profile_id=${profile.id}::uuid and screen_id=${screen}`;
    if (rows.length !== 1) throw new Error('Campaign route fixture unavailable');
    return rows[0]!;
  });
  // Leave the transaction before suspending. This exercises the real route boundary.
  if (record.mode === 'loading') await new Promise((resolve) => setTimeout(resolve, 30_000));
  if (record.mode === 'error') throw new Error('Synthetic campaign route failure');
  return schema.parse(record.payload);
}
