import type { ScreenActor } from '../../server/page-read';

import type { ScreenParams } from '../types';

/**
 * `/ngrams` — the n-gram explorer.
 *
 * A search-term report is thousands of rows of which most have one or two
 * clicks, so no single row carries evidence; the signal lives in the words
 * those rows share. This page loads the profile's search terms for a period
 * once and hands them to the client, which aggregates them in the engine — so
 * the uni/bi/tri toggle, the scope selector and the click floor are instant and
 * cost no round trip.
 *
 * Loading the whole set is the same decision the grid makes and for the same
 * reason. Past the cap the page says the set is truncated rather than showing
 * an unmarked prefix whose totals nobody can trust.
 */
import { pageReadErrorMessage } from '../../server/authenticated-page-read';

import { redirect } from 'next/navigation';

import { authenticationDestination } from '../../server/request-context';

import { listOrgProfiles } from '../../recommendations/data';

import { loadScopes, loadSearchTermRows } from '../../ngrams/data';

import { periodFromParams, todayIso } from '../../../app/_lib/periods';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function load(access: ScreenActor, input: ScreenParams) {
  const searchParams = Promise.resolve(input.searchParams) as { searchParams: SearchParams; }['searchParams'];

  try {
    return await access.read(async (database, actor) => {
      const query = await searchParams;

      const profiles = await listOrgProfiles(database, actor.orgId);
      const profile = access.selectProfile(profiles, one(query['profile']));
      if (profile === null) {
        return { view: 'empty' as const, props: {} };
      }

      const from = one(query['from']);
      const to = one(query['to']);
      const period = periodFromParams(
        { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) },
        todayIso(),
      );
      const [payload, scopes] = await Promise.all([
        loadSearchTermRows(database, {
          orgId: actor.orgId,
          profileId: profile.id,
          period,
        }),
        loadScopes(database, { orgId: actor.orgId, profileId: profile.id }),
      ]);

      const orders=payload.rows.reduce((n,r)=>n+r.purchases7d,0);
      const sales=payload.rows.reduce((n,r)=>n+r.sales7d,0);
      const negativeOptions=profile.targetAcos!==null&&profile.targetAcos>0&&orders>0?{targetAcos:profile.targetAcos,aov:sales/orders}:null;
      return { view: 'ready' as const, props: { profile, period, payload, scopes, negativeOptions } };
    });
  } catch (error) {
    // A page, not an API: an anonymous visitor gets the login screen rather
    // than a 200 that reads "Authentication required".
    const authDestination = authenticationDestination(error);
    if (authDestination !== null) redirect(authDestination);
    const message = pageReadErrorMessage(error, 'The explorer is unavailable');
    return { view: 'error' as const, props: { message } };
  }
}
