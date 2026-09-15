import { afterAll, beforeAll, expect, it } from 'vitest';
import { SponsoredPromptImport, type SponsoredPromptImportRow } from '@wizard-ads/shared';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { asUser } from '../testing/rls.js';
import { withAuthenticatedOrgEditor } from './authenticated-actor.js';
import { importSponsoredPrompts, readSponsoredPrompts, recordSponsoredPromptVisit } from './sponsored-prompts.js';

let database: TestDatabase; let orgId: string; let profileId: string; let foreignProfile: string;
let campaignId: string; let adGroupId: string; let adProduct: 'SP' | 'SB';
const owner = '00000000-0000-4000-8000-000000000071'; const colleague = '00000000-0000-4000-8000-000000000072'; const outsider = '00000000-0000-4000-8000-000000000073';
const at = (day: number) => `2026-06-${String(day).padStart(2, '0')}T00:00:00.000Z`;
const row = (promptText: string, day = 2, status: 'live' | 'paused' = 'live'): SponsoredPromptImportRow => ({
  adProduct, campaignId, adGroupId, promptText, observedAt: at(day), status, intervalStart: at(day - 1), intervalEnd: at(day), spend: 3, clicks: 2, sales: 6, orders: 1,
});
const importRows = (rows: SponsoredPromptImportRow[]) => withAuthenticatedOrgEditor(database, { orgId, userId: owner }, (context) => importSponsoredPrompts(context, SponsoredPromptImport.parse({ profileId, metricSemantics: 'disjoint_interval_deltas', rows })));
const read = (userId = owner) => asUser(database, userId, (sql) => readSponsoredPrompts({ sql }, { orgId, profileId, userId }));
beforeAll(async () => {
  database = await createTestDatabase('wp267_prompts');
  const [tenant] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture('synthetic-prompts-a',${owner},'owner') as id`; orgId = tenant!.id;
  const [foreign] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture('synthetic-prompts-b',${outsider},'owner') as id`;
  const [profile] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id=${orgId}`; profileId = profile!.id;
  const [otherProfile] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id=${foreign!.id}`; foreignProfile = otherProfile!.id;
  const [group] = await database.sql<{ campaign_id: string; amazon_id: string; ad_product: 'SP' | 'SB' }[]>`select campaign_id,amazon_id,ad_product from public.ad_groups where org_id=${orgId} and profile_id=${profileId} and ad_product in ('SP','SB') limit 1`;
  campaignId = group!.campaign_id; adGroupId = group!.amazon_id; adProduct = group!.ad_product;
  await database.sql`delete from public.sponsored_prompt_visits where org_id=${orgId}`;
  await database.sql`select public.auth_user_stub(${colleague})`;
  await database.sql`insert into public.org_members(org_id,user_id,role) values(${orgId},${colleague},'analyst')`;
}, 60_000);
afterAll(async () => { await database?.drop(); });

it('upserts normalized identity, appends observations and reconciles idempotent re-import counts', async () => {
  expect(await importRows([row('Synthetic repeated prompt')])).toEqual({ offered: 1, prompts: 1, inserted: 1, alreadyPresent: 0, verified: 1 });
  expect(await importRows([row('  SYNTHETIC   repeated prompt '), row('Synthetic repeated prompt', 3)])).toEqual({ offered: 2, prompts: 1, inserted: 1, alreadyPresent: 1, verified: 2 });
  const prompt = (await read()).prompts.find((item) => item.normalizedPrompt === 'synthetic repeated prompt');
  expect(prompt?.observations).toHaveLength(2); expect(prompt?.firstSeenAt).toBe(at(2)); expect(prompt?.lastSeenAt).toBe(at(3));
});
it('rejects conflicting re-imports and overlapping export intervals atomically', async () => {
  await expect(importRows([{ ...row('Synthetic repeated prompt'), spend: 5 }])).rejects.toThrow('different values');
  await expect(importRows([{ ...row('Synthetic repeated prompt', 4), intervalStart: at(2) }])).rejects.toThrow('overlap');
  await expect(importRows([row('Synthetic rollback prompt'), { ...row('Synthetic repeated prompt'), sales: 99 }])).rejects.toThrow();
  expect((await read()).prompts.some((prompt) => prompt.promptText === 'Synthetic rollback prompt')).toBe(false);
});
it('keeps chronology on late imports and retains live-after-paused observations', async () => {
  await importRows([row('Synthetic return prompt', 6)]);
  await importRows([row('Synthetic return prompt', 3, 'paused'), row('Synthetic return prompt', 2)]);
  const prompt = (await read()).prompts.find((item) => item.promptText === 'Synthetic return prompt');
  expect(prompt).toMatchObject({ firstSeenAt: at(2), lastSeenAt: at(6), currentStatus: 'live' });
  expect(prompt?.observations.map((observation) => observation.status)).toEqual(['live', 'paused', 'live']);
  expect(prompt?.observations.reduce((sum, observation) => sum + observation.spend!, 0)).toBe(9);
  expect(prompt?.observations.reduce((sum, observation) => sum + observation.sales!, 0)).toBe(18);
});
it('serializes concurrent import retries without duplicating observations', async () => {
  const results = await Promise.all([importRows([row('Synthetic concurrent prompt')]), importRows([row('Synthetic concurrent prompt')])]);
  expect(results.reduce((sum, result) => sum + result.inserted, 0)).toBe(1);
  expect(results.reduce((sum, result) => sum + result.alreadyPresent, 0)).toBe(1);
});
it('captures first visits read-only and advances each user marker without stale-tab regression', async () => {
  expect((await read()).lastVisitedAt).toBeNull();
  const before = await read(); expect((await read()).lastVisitedAt).toBeNull();
  const save = (userId: string, viewedThrough: string) => withAuthenticatedOrgEditor(database, { orgId, userId }, (context) => recordSponsoredPromptVisit(context, { profileId, viewedThrough }));
  await save(owner, at(4)); await save(owner, at(2)); await save(colleague, at(3));
  expect((await read()).lastVisitedAt).toBe(at(4)); expect((await read(colleague)).lastVisitedAt).toBe(at(3));
  expect(before.lastVisitedAt).toBeNull();
  expect(await asUser(database, owner, (sql) => sql`select user_id from public.sponsored_prompt_visits where profile_id=${profileId}`)).toHaveLength(1);
});
it('refuses foreign profiles, campaign/group mismatches and forged per-user visits', async () => {
  await expect(withAuthenticatedOrgEditor(database, { orgId, userId: owner }, (context) => importSponsoredPrompts(context, { profileId: foreignProfile, metricSemantics: 'disjoint_interval_deltas', rows: [row('Synthetic foreign')] }))).rejects.toThrow('Profile not found');
  await expect(importRows([{ ...row('Synthetic mismatch'), adGroupId: 'missing-group' }])).rejects.toThrow('not found');
  await expect(asUser(database, outsider, (sql) => readSponsoredPrompts({ sql }, { orgId, profileId, userId: outsider }))).rejects.toThrow('Profile not found');
  await expect(asUser(database, owner, (sql) => sql`insert into public.sponsored_prompt_visits(org_id,profile_id,user_id,last_visited_at) values(${orgId},${profileId},${outsider},${at(2)})`)).rejects.toThrow();
});
it('enforces append-only observations and future-marker rejection in the database', async () => {
  const prompt = (await read()).prompts.find((item) => item.normalizedPrompt === 'synthetic repeated prompt')!;
  await expect(database.sql`update public.sponsored_prompt_observations set spend=0 where prompt_id=${prompt.id}`).rejects.toThrow('append-only');
  await expect(database.sql`delete from public.sponsored_prompt_observations where prompt_id=${prompt.id}`).rejects.toThrow('append-only');
  await expect(database.sql`truncate public.sponsored_prompt_observations`).rejects.toThrow('append-only');
  await expect(database.sql`update public.sponsored_prompts set current_status='paused' where id=${prompt.id}`).rejects.toThrow('comes from observations');
  await expect(withAuthenticatedOrgEditor(database, { orgId, userId: owner }, (context) => recordSponsoredPromptVisit(context, { profileId, viewedThrough: '2099-01-01T00:00:00.000Z' }))).rejects.toThrow('Future visit');
});
it('returns complete calendar-day metric bounds in the profile timezone', async () => {
  const snapshot = await read();
  const [window] = await database.sql<{ midnight: boolean; days: number }[]>`select
    (${snapshot.windowEnd}::timestamptz at time zone timezone)::time='00:00'::time as midnight,
    (${snapshot.windowEnd}::timestamptz at time zone timezone)::date-(${snapshot.windowStart}::timestamptz at time zone timezone)::date as days
    from public.ad_profiles where id=${profileId}`;
  expect(window).toEqual({ midnight: true, days: 30 });
  expect(Date.parse(snapshot.windowEnd)).toBeLessThanOrEqual(Date.parse(snapshot.viewedThrough));
});
