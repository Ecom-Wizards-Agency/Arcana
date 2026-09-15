import { readBrandLens } from '@wizard-ads/db';
import { listProfiles } from '../../../app/_lib/profiles';
import { periodFromParams, todayIso } from '../../../app/_lib/periods';
import type { ScreenActor } from '../../server/page-read';
import type { ScreenParams } from '../types';
export async function load(access: ScreenActor, input: ScreenParams) {
  if (access.entry.state !== 'ok') return { view: 'gated' as const };
  try {
    return await access.snapshot(async snapshot => {
      const profiles = await listProfiles(snapshot, snapshot.actor.orgId), profile = access.selectProfile(profiles);
      if (!profile) return { view: 'empty' as const };
      const period = periodFromParams({
        from: typeof input.searchParams['from'] === 'string' ? input.searchParams['from'] : undefined,
        to: typeof input.searchParams['to'] === 'string' ? input.searchParams['to'] : undefined
      }, todayIso());
      return {
        view: 'ready' as const,
        profile,
        period,
        source: await readBrandLens(snapshot, profile.id, period)
      };
    });
  } catch {
    return {
      view: 'error' as const,
      message: 'Brand lens could not be loaded. Try again.'
    };
  }
}
