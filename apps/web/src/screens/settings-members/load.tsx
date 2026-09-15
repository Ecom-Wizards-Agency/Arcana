import type { ScreenActor } from '../../server/page-read';

import type { ScreenParams } from '../types';

/** `/settings/members` — invitation issuance and the organisation roster. */

import { can } from '../../auth/roles';

import { listPendingInvitations } from '../../data/invitations';

import { listMembers } from '../../data/members';

export async function load(access: ScreenActor, _input: ScreenParams) {

  const entry = access.entry;
  if (entry.state !== 'ok') {
    return { view: 'gated' as const, props: { entry } };
  }

  const { handle, context } = entry;
  const active = context.active;
  if (!active) return null;

  if (!can(active.role, 'manageMembers')) {
    return { view: 'forbidden' as const, props: { context, active } };
  }

  const [members, invitations] = await Promise.all([
    listMembers(handle, { orgId: active.orgId, userId: context.user.id }),
    listPendingInvitations(handle, { orgId: active.orgId, userId: context.user.id }),
  ]);

  return { view: 'ready' as const, props: { context, active, members, invitations } };
}
