import { readOptimizationGroupPerformance } from '@wizard-ads/db';
import type { ScreenActor } from '../../server/page-read';
import type { ScreenParams } from '../types';
import { load as loadGroups } from '../optimizer-groups/load';
import { periodFromParams, precedingPeriod, todayIso } from '../../../app/_lib/periods';
import { Uuid } from '@wizard-ads/shared';
export async function load(access: ScreenActor, input: ScreenParams) {
  const data = await loadGroups(access, input);
  if (data.view !== 'ready') return data;
  const groupId = Uuid.safeParse(input.params['groupId']);
  const record = groupId.success ? data.props.workspace.groups.find((entry) => entry.group.id === groupId.data) : undefined;
  if (record === undefined) return { view: 'missing' as const, props: { profileId: data.props.profile.id } };
  const raw = input.searchParams;
  const current = periodFromParams({ from: typeof raw['from'] === 'string' ? raw['from'] : undefined, to: typeof raw['to'] === 'string' ? raw['to'] : undefined }, todayIso());
  const previous = precedingPeriod(current);
  const performance = await access.readSql((sql) => readOptimizationGroupPerformance({ sql }, {
    orgId: record.group.orgId, profileId: record.group.profileId, groupId: record.group.id, current, previous,
  }));
  if (performance === null) return { view: 'missing' as const, props: { profileId: data.props.profile.id } };
  return { view: 'ready' as const, props: { ...data.props, record, performance } };
}
