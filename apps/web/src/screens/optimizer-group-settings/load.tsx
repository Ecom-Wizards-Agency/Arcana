import { Uuid } from '@wizard-ads/shared';
import type { ScreenActor } from '../../server/page-read';
import type { ScreenParams } from '../types';
import { load as loadGroups } from '../optimizer-groups/load';
export async function load(access: ScreenActor, input: ScreenParams) {
  const data = await loadGroups(access, input);
  if (data.view !== 'ready') return data;
  const id = Uuid.safeParse(input.params['groupId']);
  const record = id.success ? data.props.workspace.groups.find((entry) => entry.group.id === id.data) : undefined;
  if (record === undefined) return { view: 'missing' as const, props: { profileId: data.props.profile.id } };
  return { view: 'ready' as const, props: { ...data.props, record, editing: input.searchParams['edit'] === '1' } };
}
