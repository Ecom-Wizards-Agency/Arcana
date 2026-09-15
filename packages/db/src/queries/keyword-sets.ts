import { CampaignKeywordSet, Uuid } from '@wizard-ads/shared';
import type { AuthenticatedEditorTransaction, AuthenticatedReadSnapshot } from './authenticated-actor.js';

export async function listCampaignKeywordSets(context: AuthenticatedReadSnapshot | AuthenticatedEditorTransaction, profileId: string): Promise<CampaignKeywordSet[]> {
  Uuid.parse(profileId);
  const rows = await context.sql`select id,profile_id as "profileId",name,keywords from public.keyword_sets
    where org_id=${context.actor.orgId}::uuid and profile_id=${profileId}::uuid order by name,id`;
  return rows.map((row) => CampaignKeywordSet.parse(row));
}
export async function saveCampaignKeywordSet(context: AuthenticatedEditorTransaction, input: unknown): Promise<CampaignKeywordSet> {
  const value = CampaignKeywordSet.parse(input);
  const rows = await context.sql`insert into public.keyword_sets(id,org_id,profile_id,name,keywords)
    values (${value.id}::uuid,${context.actor.orgId}::uuid,${value.profileId}::uuid,${value.name},${JSON.stringify(value.keywords)}::text::jsonb)
    on conflict (id) do update set name=excluded.name,keywords=excluded.keywords
      where keyword_sets.org_id=excluded.org_id and keyword_sets.profile_id=excluded.profile_id
    returning id,profile_id as "profileId",name,keywords`;
  if (rows.length !== 1) throw new Error('Keyword set save count mismatch');
  return CampaignKeywordSet.parse(rows[0]);
}
