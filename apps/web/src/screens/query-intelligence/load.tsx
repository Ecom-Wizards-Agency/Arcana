import type { SpEvidence } from '@wizard-ads/shared';
import type { ScreenActor } from '../../server/page-read';
import { readCoreReportEvidence } from '@wizard-ads/db';

import type { ScreenParams } from '../types';

import { redirect } from 'next/navigation';

import {
  readResearchProfile, readSpReportEvidence,
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

      const researchProfile = await readResearchProfile(snapshot, profile.id);
      const { periodFromParams, todayIso } = await import('../../../app/_lib/periods');
      const period = periodFromParams({from:one(query['from']),to:one(query['to'])},todayIso());
      const inWindow = one(query['from']) || one(query['to']) ? scopes.filter(s => s.weekStart >= period.start && s.weekEnd <= period.end) : scopes;
      const selected = selectedScope(inWindow, one(query['scope']));
      const scope = selected ?? {marketplaceId:researchProfile.marketplaceId,weekStart:period.start,weekEnd:period.end,factRows:0,asinCount:0,queryCount:0,loadedAt:new Date().toISOString()};
      const rawCategory = one(query['category']);
      const categoryResult = QueryCategory.safeParse(rawCategory);
      const category = categoryResult.success ? categoryResult.data : null;
      const search = one(query['q'])?.slice(0, 160) ?? '';
      const endDate = scope?.weekEnd ?? new Date().toISOString().slice(0, 10);
      const startDate = scope?.weekStart ?? new Date(Date.parse(endDate) - 6 * 86_400_000).toISOString().slice(0, 10);
      const coreEvidence = await readCoreReportEvidence(snapshot, { orgId: actor.orgId, profileId: profile.id, families: ['sbSearchTerm'], startDate, endDate, limit: 100 });

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
      const aba = await readSpReportEvidence(snapshot, { orgId: actor.orgId, profileId: profile.id, family: 'aba', start: scope.weekStart, end: scope.weekEnd });

      return { view: 'ready' as const, props: { ...({ aba } as { aba?: SpEvidence }), profile, scope, scopes, category, search, model, contextualReview, contextualExports, role, ...(coreEvidence.length ? { coreEvidence } : {}) } };
    });
  } catch (error) {
    const authDestination = authenticationDestination(error);
    if (authDestination !== null) redirect(authDestination);
    const message = pageReadErrorMessage(error, 'Query Intelligence is unavailable');
    return { view: 'error' as const, props: { message } };
  }
}
