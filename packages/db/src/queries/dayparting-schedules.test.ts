import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { withAuthenticatedOrgEditor, withAuthenticatedReadSnapshot } from './authenticated-actor.js';
import { saveDaypartingDraft, listDaypartingSchedules, reviewDaypartingSchedule, daypartingReviewEvidence } from './dayparting-schedules.js';
import { mutateQueryVocabularyForActor } from './sqp.js';
import { setCampaignOptimizationExclusion } from './optimization-groups.js';
import { readBrandLens, saveBrandLensOverride } from './brand-lens.js';
const owner = '26262626-2626-4262-8262-262626262626';
describe('research actor persistence', () => {
  let db: TestDatabase, orgId: string, profileId: string, campaignId: string, timezone: string;
  const grid = () => Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  beforeAll(async () => {
    db = await createTestDatabase('wp266_research');
    const [org] = await db.sql<{ id: string }[]>`select app.seed_tenant_fixture('research-fixture',${owner},'owner') as id`;
    orgId = org!.id;
    const [profile] = await db.sql<{ id: string; timezone: string }[]>`select id,timezone from public.ad_profiles where org_id=${orgId} order by id limit 1`;
    profileId = profile!.id;
    timezone = profile!.timezone;
    const [campaign] = await db.sql<{ id: string }[]>`select amazon_id as id from public.campaigns where org_id=${orgId} and profile_id=${profileId} and ad_product='SP' limit 1`;
    campaignId = campaign!.id;
  }, 120000);
  afterAll(async () => {
    await db?.drop();
  });
  const actor = () => ({
    userId: owner,
    orgId
  });
  it('edits a stored draft and replaces its exact campaign set', async()=>{
    const stored=await withAuthenticatedReadSnapshot(db,actor(),context=>listDaypartingSchedules(context,profileId));
    const fixture=stored.find(s=>s.name==='Synthetic fixture schedule')!;
    const saved=await withAuthenticatedOrgEditor(db,actor(),context=>saveDaypartingDraft(context,{id:fixture.id,expectedUpdatedAt:fixture.updatedAt,profileId,name:'Synthetic edited draft',modifiers:grid(),campaignIds:[campaignId],sourceProposalId:null}));
    expect(saved.name).toBe('Synthetic edited draft');expect(saved.campaignIds).toEqual([campaignId]);
  });
  it('persists all cells, rejects stale edits, and records a campaign-bound evidence review', async () => {
    const modifiers = grid();
    modifiers[2]![7] = 46;
    const schedule = await withAuthenticatedOrgEditor(db, actor(), context => saveDaypartingDraft(context, {
      profileId,
      name: 'Synthetic schedule',
      modifiers,
      campaignIds: [campaignId],
      sourceProposalId: null
    }));
    expect(schedule.modifiers.flat()).toHaveLength(168);
    expect(schedule.modifiers[2]![7]).toBe(46);
    expect(schedule.campaignIds).toEqual([campaignId]);
    expect(schedule.timezone).toBe(timezone);
    const evidence = daypartingReviewEvidence({
      start: '2026-06-01',
      end: '2026-06-01',
      campaignIds: [campaignId],
      maturityPolicyConfigured: true,
      facts: [{
        profileId,
        adProduct: 'SP',
        campaignId,
        utcHour: '2026-06-01T07:00:00Z',
        profileTimeZone: timezone,
        localDate: '2026-06-01',
        localHour: 7,
        localDayOfWeek: 1,
        currencyCode: 'USD',
        impressions: 100,
        clicks: 10,
        cost: 17,
        sales: 68,
        purchases: 2,
        budgetUsagePercent: null,
        budgetCapped: false,
        settlingState: 'settled',
        sourceEvents: 2
      }]
    });
    const reviewed = await withAuthenticatedOrgEditor(db, actor(), context => reviewDaypartingSchedule(context, {
      profileId,
      id: schedule.id,
      expectedUpdatedAt: schedule.updatedAt,
      evidenceStart: evidence.start,
      evidenceEnd: evidence.end,
      evidenceFingerprint: evidence.fingerprint
    }, evidence));
    expect(reviewed.status).toBe('reviewed');
    expect(reviewed.review).toMatchObject({
      reviewedBy: owner,
      campaignIds: [campaignId],
      modifiers
    });
    expect(Date.parse(reviewed.review!.reviewedAt)).not.toBeNaN();
    await expect(withAuthenticatedOrgEditor(db, actor(), context => saveDaypartingDraft(context, {
      profileId,
      id: schedule.id,
      expectedUpdatedAt: schedule.updatedAt,
      name: schedule.name,
      modifiers,
      campaignIds: [campaignId],
      sourceProposalId: null
    }))).rejects.toThrow('changed');
    for (const status of ['enabled', 'paused']) await expect(withAuthenticatedOrgEditor(db, actor(), async context => {
      await context.sql`update public.dayparting_schedules set status=${status} where id=${schedule.id}`;
    })).rejects.toThrow();
    const second = await withAuthenticatedOrgEditor(db, actor(), context => saveDaypartingDraft(context, {
      profileId,
      name: 'Synthetic alternative',
      modifiers: grid(),
      campaignIds: [campaignId],
      sourceProposalId: null
    }));
    await db.sql`update public.dayparting_schedules set status='enabled',enabled_at=now() where id=${schedule.id}`;
    await db.sql`update public.dayparting_schedules set status='reviewed',reviewed_by=${owner},reviewed_at=now(),review_record=${JSON.stringify(reviewed.review)}::jsonb where id=${second.id}`;
    await expect(db.sql`update public.dayparting_schedules set status='enabled',enabled_at=now() where id=${second.id}`).rejects.toThrow();
    const read = await withAuthenticatedReadSnapshot(db, actor(), context => listDaypartingSchedules(context, profileId));
    expect(read).toHaveLength(3);
    expect(read.filter(s => s.status === 'enabled')).toHaveLength(1);
  });
  it('adds and approves vocabulary with actor/time, then preserves keyword overrides', async () => {
    const added = await withAuthenticatedOrgEditor(db, actor(), context => mutateQueryVocabularyForActor(context, {
      action: 'add',
      profileId,
      kind: 'own_brand_alias',
      value: 'Synthetik'
    }));
    expect(added.changed).toBe(1);
    const entry = added.entries.find(e => e.value === 'Synthetik')!;
    expect(entry.source).toBe('operator');
    expect(entry.approved).toBe(false);
    const approved = await withAuthenticatedOrgEditor(db, actor(), context => mutateQueryVocabularyForActor(context, {
      action: 'approve',
      profileId,
      id: entry.id!
    }));
    expect(approved.entries.find(e => e.id === entry.id)?.approved).toBe(true);
    const [stamp] = await db.sql<{ reviewed_by: string; reviewed_at: Date }[]>`select reviewed_by,reviewed_at from public.query_vocabulary where id=${entry.id!}`;
    expect(stamp!.reviewed_by).toBe(owner);
    expect(Date.parse(String(stamp!.reviewed_at))).not.toBeNaN();
    await withAuthenticatedOrgEditor(db, actor(), context => saveBrandLensOverride(context, {
      profileId,
      keyword: 'Synthetik part',
      bucket: 'generic',
      decision: 'changed'
    }));
    const source = await withAuthenticatedReadSnapshot(db, actor(), context => readBrandLens(context, profileId, {
      start: '2026-06-01',
      end: '2026-06-07'
    }));
    expect(source.overrides).toHaveLength(2);
    expect(source.overrides.find(o => o.normalizedKeyword === 'synthetik part')).toMatchObject({
      normalizedKeyword: 'synthetik part',
      bucket: 'generic',
      decidedBy: owner
    });
  });
  it('updates only one group exclusion while preserving its other settings', async () => {
    const [group] = await db.sql<{ id: string }[]>`select id from public.optimization_groups where org_id=${orgId} and profile_id=${profileId} limit 1`;
    if (!group) throw new Error('Synthetic group required');
    await db.sql`insert into public.campaign_optimization_assignments(org_id,profile_id,campaign_id,group_id) values(${orgId},${profileId},${campaignId},${group.id}) on conflict(profile_id,campaign_id) do update set group_id=excluded.group_id`;
    const result = await withAuthenticatedOrgEditor(db, actor(), context => setCampaignOptimizationExclusion(context, {
      profileId,
      campaignId,
      excluded: true
    }));
    expect(result.exclusions).toContain(campaignId);
    const included = await withAuthenticatedOrgEditor(db, actor(), context => setCampaignOptimizationExclusion(context, {
      profileId,
      campaignId,
      excluded: false
    }));
    expect(included.exclusions).not.toContain(campaignId);
  });
});
