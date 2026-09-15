import { CampaignNamingPreset, NamingStrategy, Uuid } from '@wizard-ads/shared';
import type { AuthenticatedEditorTransaction, AuthenticatedReadSnapshot } from './authenticated-actor.js';

export async function listCampaignNamingPresets(context: AuthenticatedReadSnapshot | AuthenticatedEditorTransaction): Promise<CampaignNamingPreset[]> {
  const rows = await context.sql`select p.id,p.name,p.naming,p.created_by as "createdBy",
    (select count(*)::int from public.ad_profiles a where a.org_id=p.org_id and
      (select s.doc->'naming' from public.profile_strategy s where s.org_id=a.org_id
       and (s.profile_id=a.id or s.profile_id is null) order by s.profile_id nulls last,s.updated_at desc limit 1)=p.naming) as "usageCount"
    from public.naming_presets p where p.org_id=${context.actor.orgId}::uuid order by p.name,p.id`;
  return rows.map((row) => CampaignNamingPreset.parse(row));
}
export async function saveCampaignNamingPreset(context: AuthenticatedEditorTransaction, input: { name: string; naming: NamingStrategy }): Promise<CampaignNamingPreset> {
  const name = CampaignNamingPreset.shape.name.parse(input.name);
  const naming = NamingStrategy.parse(input.naming);
  const rows = await context.sql`insert into public.naming_presets(org_id,name,naming,created_by)
    values (${context.actor.orgId}::uuid,${name},${JSON.stringify(naming)}::text::jsonb,${context.actor.userId}::uuid)
    on conflict (org_id,name) do update set naming=excluded.naming
    returning id,name,naming,created_by as "createdBy",0 as "usageCount"`;
  if (rows.length !== 1) throw new Error('Naming preset save count mismatch');
  const identity = CampaignNamingPreset.parse(rows[0]);
  const saved = (await listCampaignNamingPresets(context)).find((preset) => preset.id === identity.id);
  if (!saved) throw new Error('Saved naming preset unavailable');
  return saved;
}
export async function copyCampaignNamingPreset(context: AuthenticatedEditorTransaction, presetId: string, profileId: string): Promise<void> {
  Uuid.parse(presetId); Uuid.parse(profileId);
  const profiles = await context.sql`select id from public.ad_profiles where org_id=${context.actor.orgId}::uuid and id=${profileId}::uuid for update`;
  const presets = await context.sql<{ naming: unknown }[]>`select naming from public.naming_presets where org_id=${context.actor.orgId}::uuid and id=${presetId}::uuid`;
  if (profiles.length !== 1 || presets.length !== 1) throw new Error('Profile or naming preset unavailable');
  const naming = NamingStrategy.parse(presets[0]!.naming);
  const rows = await context.sql`insert into public.profile_strategy(org_id,profile_id,schema_version,doc,updated_by)
    select ${context.actor.orgId}::uuid,${profileId}::uuid,s.schema_version,
      jsonb_set(s.doc,'{naming}',${JSON.stringify(naming)}::text::jsonb),${context.actor.userId}::uuid
    from public.profile_strategy s where s.org_id=${context.actor.orgId}::uuid and (s.profile_id=${profileId}::uuid or s.profile_id is null)
    order by s.profile_id nulls last,s.updated_at desc limit 1
    on conflict (org_id,profile_id) do update set doc=jsonb_set(profile_strategy.doc,'{naming}',${JSON.stringify(naming)}::text::jsonb),updated_by=excluded.updated_by
    returning id`;
  if (rows.length !== 1) throw new Error('Configure a strategy for this profile before copying a naming preset');
}
