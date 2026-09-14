import type { ScreenActor } from '../../server/page-read';

import type { ScreenParams } from '../types';

/** The retired tracker: old item links are routed to their new typed home. */

import { redirect } from 'next/navigation';

import { getFeedbackItem } from '@wizard-ads/db';

import { authenticationDestination } from '../../server/request-context';

import { requireOrgRole } from '../../server/org-role';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const single = (value: string | string[] | undefined): string | null =>
  typeof value === 'string' ? value : null;

export async function load(access: ScreenActor, input: ScreenParams) {
  const searchParams = Promise.resolve(input.searchParams) as { searchParams: SearchParams; }['searchParams'];

  const query = await searchParams;
  const candidate = single(query['item']) ?? single(query['id']) ?? single(query['feedback']);

  // A fragment is not present in the HTTP request. This bridge gets one client
  // turn to convert #feedback-<id> into ?item=<id>, then comes back through the
  // authenticated, tenant-scoped lookup below.
  if (candidate === null) return { view: 'bridge' as const, props: {} };
  if (!UUID.test(candidate)) redirect('/bugs');

  let destination = '/bugs';
  try {
    destination = await access.read(async (database, actor) => {
      await requireOrgRole(database, actor);
      const item = await getFeedbackItem(database, {
        orgId: actor.orgId,
        itemId: candidate,
        viewerId: actor.userId,
      });
      if (item?.type === 'feature') return `/roadmap#roadmap-${item.id}`;
      if (item?.type === 'bug') return `/bugs#bug-${item.id}`;
      return '/bugs';
    });
  } catch (error) {
    const authDestination = authenticationDestination(error);
    if (authDestination !== null) redirect(authDestination);
  }
  redirect(destination);
}
