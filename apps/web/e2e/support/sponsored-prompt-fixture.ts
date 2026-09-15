import { createDb } from '@wizard-ads/db';
import type { E2EState } from './fixture';

/** A fresh profile keeps the pre-import state separate from the tenant RLS fixture. */
export async function seedPromptImportProfile(state: E2EState): Promise<E2EState> {
  const db = createDb({ connectionString: state.connectionString });
  try {
    const profiles = await db.sql<{ id: string }[]>`
      insert into public.ad_profiles(org_id,amazon_profile_id,region,country_code,currency_code,timezone,sync_enabled)
      values (${state.orgId},'synthetic-prompts-browser-profile','NA','US','USD','UTC',false) returning id`;
    if (profiles.length !== 1 || !profiles[0]) throw new Error('Prompt browser fixture expected one profile');
    const profileId = profiles[0].id;
    const campaigns = await db.sql`
      insert into public.campaigns(org_id,profile_id,amazon_id,ad_product,name,state,budget_amount,budget_type)
      values (${state.orgId},${profileId},'c-1','SP','Synthetic prompt campaign','enabled',17,'daily') returning amazon_id`;
    const groups = await db.sql`
      insert into public.ad_groups(org_id,profile_id,amazon_id,ad_product,name,state,campaign_id,default_bid)
      values (${state.orgId},${profileId},'ag-1','SP','Synthetic prompt ad group','enabled','c-1',0.7) returning amazon_id`;
    if (campaigns.length !== 1 || groups.length !== 1) throw new Error('Prompt browser fixture entity counts did not reconcile');
    return { ...state, fixtureProfileId: profileId };
  } finally { await db.close(); }
}
