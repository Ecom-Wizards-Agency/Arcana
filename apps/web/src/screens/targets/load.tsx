import { notFound } from 'next/navigation';
import { loadTarget360 } from './model';
import { periodFromParams, todayIso } from '../../../app/_lib/periods';
import { listProfiles } from '../../../app/_lib/profiles';
import { gridBackLocation } from '../../server/view-state';
import type { ScreenActor } from '../../server/page-read';
import type { ScreenParams } from '../types';

export async function load(access: ScreenActor, input: ScreenParams) {
  if (access.entry.state !== 'ok') return { view: 'gated' as const, state: access.entry.state };
  const query = input.searchParams;
  const period = periodFromParams({
    from: typeof query['from'] === 'string' ? query['from'] : undefined,
    to: typeof query['to'] === 'string' ? query['to'] : undefined,
  }, todayIso());
  const data = await access.read(async (handle, actor) => {
    const profiles = await listProfiles(handle, actor.orgId);
    const profile = access.selectProfile(profiles, access.requestedProfile);
    if (profile === null) return null;
    const model = await loadTarget360(handle, { orgId: actor.orgId, profileId: profile.id,
      targetId: input.params['id'] ?? '', from: period.start, to: period.end });
    if (model === null) return null;
    return { ...model, currencyCode: profile.currencyCode };
  });
  if (data === null) notFound();
  return { view: 'ready' as const, ...data, back: gridBackLocation(query['back']), savedView: typeof query['view'] === 'string' ? query['view'] : null, ...(query['limits'] === '1' ? { showLimits: true } : {}) };
}
