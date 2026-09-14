import type { ScreenActor } from '../../server/page-read';

import type { ScreenParams } from '../types';

/** `/settings/account` — password login for any organisation member. */

import { authFeatureConfig } from '../../auth/config';

import { loadTotpOverview } from '../../auth/totp';

import { safeNextPath } from '../../auth/next-path';

export async function load(access: ScreenActor, input: ScreenParams) {
  const searchParams = Promise.resolve(input.searchParams) as {
    searchParams: Promise<{ next?: string; }>;
  }['searchParams'];

  const entry = access.entry;
  if (entry.state !== 'ok') {
    return { view: 'gated' as const, props: { entry } };
  }
  if (!entry.context.active) return null;
  const config = authFeatureConfig();
  const totp = await loadTotpOverview();
  const next = safeNextPath((await searchParams).next, '/settings/account');

  return { view: 'ready' as const, props: { context: entry.context, totp, next, config } };
}
