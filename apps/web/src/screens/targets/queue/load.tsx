import { notFound } from 'next/navigation';
import { listQueuedTargetChanges } from '@wizard-ads/db';
import { Uuid } from '@wizard-ads/shared';
import type { ScreenActor } from '../../../server/page-read';
import type { ScreenParams } from '../../types';
import { gridBackLocation } from '../../../server/view-state';
export async function load(access: ScreenActor, input: ScreenParams) {
  if (access.entry.state !== 'ok') return { view: 'gated' as const, state: access.entry.state };
  const profile = Uuid.safeParse(input.searchParams['profile']);
  if (!profile.success) notFound();
  const change = await access.read(async (handle, actor) => (await listQueuedTargetChanges(handle, actor.orgId, profile.data, input.params['id'] ?? '')).find((row) => row.id === input.params['changeId']));
  if (!change) notFound();
  return { view: 'ready' as const, change, back: gridBackLocation(input.searchParams['back']) };
}
