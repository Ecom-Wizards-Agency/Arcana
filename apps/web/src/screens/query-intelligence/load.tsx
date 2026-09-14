import type { ScreenActor } from '../../server/page-read';

import type { ScreenParams } from '../types';

import { redirect } from 'next/navigation';

import {
  listContextualNegativeExports,
  loadContextualNegativeReviewSnapshot
} from '@wizard-ads/db';

import { QueryCategory } from '@wizard-ads/shared';

import {
  authenticationDestination
} from '../../server/request-context';

import { requireOrgRole } from '../../server/org-role';

import { pageReadErrorMessage } from '../../server/authenticated-page-read';

import { listOrgProfiles } from '../../recommendations/data';

import {
  listQueryIntelligenceScopes,
  loadQueryIntelligenceSource,
} from '../../query-intelligence/data';

import { buildQueryIntelligenceModel } from '../../query-intelligence/model';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function selectedScope(
  scopes: Awaited<ReturnType<typeof listQueryIntelligenceScopes>>,
  value: string | undefined,
) {
  const [marketplaceId, weekStart] = value?.split('|') ?? [];
  return (
    scopes.find(
      (scope) => scope.marketplaceId === marketplaceId && scope.weekStart === weekStart,
    ) ?? scopes[0] ?? null
  );
}

export async function load(access: ScreenActor, input: ScreenParams) {
  const searchParams = Promise.resolve(input.searchParams) as {
    searchParams: SearchParams;
  }['searchParams'];

  try {
    const actor = access.actor();
    const query = await searchParams;

    return await access.snapshot(async (snapshot) => {
      const role = await requireOrgRole(snapshot, actor);
      const profiles = await listOrgProfiles(snapshot, actor.orgId);
      const profile = access.selectProfile(profiles, one(query['profile']));
      if (profile === null) {
        return { view: 'empty' as const, props: {} };
      }

      const scopes = await listQueryIntelligenceScopes(snapshot, {
        orgId: actor.orgId,
        profileId: profile.id,
      });
      const scope = selectedScope(scopes, one(query['scope']));
      const rawCategory = one(query['category']);
      const categoryResult = QueryCategory.safeParse(rawCategory);
      const category = categoryResult.success ? categoryResult.data : null;
      const search = one(query['q'])?.slice(0, 160) ?? '';

      if (scope === null) {
        return { view: 'not-measured' as const, props: { profile } };
      }

      const reviewScope = {
        orgId: actor.orgId,
        profileId: profile.id,
        marketplaceId: scope.marketplaceId,
      };
      const source = await loadQueryIntelligenceSource(snapshot, {
        ...reviewScope,
        weekStart: scope.weekStart,
        weekEnd: scope.weekEnd,
      });
      const contextualExports = await listContextualNegativeExports(snapshot, reviewScope);
      const contextualReview = await loadContextualNegativeReviewSnapshot(snapshot, {
        profileId: profile.id,
        marketplaceId: scope.marketplaceId,
      });
      const model = buildQueryIntelligenceModel(source);

      return { view: 'ready' as const, props: { profile, scope, scopes, category, search, model, contextualReview, contextualExports, role } };
    });
  } catch (error) {
    const authDestination = authenticationDestination(error);
    if (authDestination !== null) redirect(authDestination);
    const message = pageReadErrorMessage(error, 'Query Intelligence is unavailable');
    return { view: 'error' as const, props: { message } };
  }
}
