import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { withAuthenticatedOrgEditor } from './authenticated-actor.js';
import { contextualNegativeReviewFingerprint, serializeContextualNegativeExportCsv,
  type ContextualNegativeExportProposalSnapshot } from './contextual-negative-review.js';
import { mutateExperimentForActor } from './experiments.js';

const actor = { orgId: '', userId: randomUUID() };
const other = { orgId: '', userId: randomUUID() };
describe('review authority database commands', () => {
  let database: TestDatabase; let profileId: string; let otherProfileId: string;
  beforeAll(async () => {
    database = await createTestDatabase('review_authority');
    for (const owner of [actor,other]) {
      const [org] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture(${randomUUID()},${owner.userId},'owner') as id`;
      owner.orgId = org!.id;
    }
    const [profile] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id=${actor.orgId}`;
    const [foreign] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id=${other.orgId}`;
    profileId = profile!.id; otherProfileId = foreign!.id;
  },60_000);
  afterAll(async () => { await database?.drop(); });

  it('keeps service-owned relations closed to direct authenticated writes', async () => {
    const rows = await database.sql<{ relation: string; writable: boolean }[]>`select relation,
      has_table_privilege('authenticated',relation,'INSERT') as writable from unnest(
      ${['public.audit_log','public.recommendation_runs','public.contextual_negative_proposals','public.contextual_negative_exports']}::text[]) relation`;
    expect(rows).toHaveLength(4); expect(rows.every((row) => row.writable === false)).toBe(true);
  });

  it.each(['lock','audit','ngram','queryLock','queryApply'])('%s refuses another agency before writing or locking its objects', async (kind) => {
    const before = await database.sql`select id from public.audit_log order by id`;
    await expect(withAuthenticatedOrgEditor(database,actor,async ({ sql }) => {
      if (kind === 'lock') await sql`select app.lock_review_export_rows(${other.orgId},${otherProfileId},null,'[]'::jsonb)`;
      if (kind === 'audit') await sql`select app.record_recommendation_review_audit(${other.orgId},'recommendation.accepted','recommendation',${[randomUUID()]}::text[],'{}'::jsonb)`;
      if (kind === 'ngram') await sql`select app.create_ngram_review_proposals(${other.orgId},${otherProfileId},'2026-07-01','2026-07-02',2,'[]'::jsonb)`;
      if (kind === 'queryLock') await sql`select app.lock_query_negative_review(${other.orgId},${otherProfileId},'SYNTHETIC',${[randomUUID()]}::uuid[],false)`;
      if (kind === 'queryApply') await sql`select app.apply_query_negative_review(${other.orgId},${otherProfileId},'SYNTHETIC',${JSON.stringify([{ id: randomUUID() }])}::text::jsonb,'accepted','Synthetic')`;
    })).rejects.toMatchObject({ code: '42501' });
    expect(await database.sql`select id from public.audit_log order by id`).toEqual(before);
  });

  it('matches the existing fingerprint and CSV encoders for all offered adversarial text rows', async () => {
    const values = ['plain','comma,quote"','line\nreturn\r','\\literal',' =formula','\u200b@hidden','\u00a0-12','\u202e+hidden','emoji 😀'];
    const proposals: ContextualNegativeExportProposalSnapshot[] = values.map((searchTerm) => {
      const material = { orgId: actor.orgId,id: randomUUID(),profileId,marketplaceId: 'SYNTHETIC',campaignId: 'c-1',adGroupId: 'ag-1',
        searchTerm,normalizedQuery: searchTerm,category: 'excluded' as const,sourceGroupRole: 'profit' as const,
        matchType: 'negative_exact' as const,reason: 'Synthetic evidence',status: 'accepted' as const };
      return { ...material,reviewFingerprint: contextualNegativeReviewFingerprint(material) };
    });
    const rows = await database.sql<{ fingerprint: string }[]>`select app.query_negative_review_fingerprint(p) as fingerprint
      from jsonb_array_elements(${JSON.stringify(proposals)}::text::jsonb) p`;
    expect(rows).toHaveLength(values.length); expect(rows.map((r) => r.fingerprint)).toEqual(proposals.map((p) => p.reviewFingerprint));
    const [csv] = await database.sql<{ bytes: Buffer }[]>`select app.query_negative_csv(${JSON.stringify(proposals)}::text::jsonb) as bytes`;
    expect(csv!.bytes.equals(serializeContextualNegativeExportCsv(proposals))).toBe(true);
  });

  it('uses the committed experiment command and refuses illegal transitions without an event', async () => {
    const created = await mutateExperimentForActor(database,actor,{ kind: 'create',profileId,name: 'Synthetic command',type: 'other',metricFocus: 'sales' });
    const before = await database.sql`select * from public.experiment_events where experiment_id=${created.item.id}`;
    await expect(mutateExperimentForActor(database,actor,{ kind: 'transition',experimentId: created.item.id,status: 'analyzed' })).rejects.toMatchObject({ code: 'conflict' });
    expect(await database.sql`select * from public.experiment_events where experiment_id=${created.item.id}`).toEqual(before);
    expect(before).toHaveLength(1);
  });

  it('returns the appended experiment event even when timestamps are out of order', async () => {
    const [created] = await database.sql<{id:string}[]>`insert into public.experiments(org_id,profile_id,created_by,name,type,metric_focus,status,created_at)
      values(${actor.orgId},${profileId},${actor.userId},'Synthetic chronology','other','sales','planned',now()+interval '1 day') returning id`;
    const [initialEvent] = await database.sql<{id:number}[]>`select id from public.experiment_events where experiment_id=${created!.id}`;
    const moved = await mutateExperimentForActor(database,actor,{ kind: 'transition',experimentId: created!.id,status: 'running' });
    expect(moved.event).toMatchObject({ fromStatus: 'planned',toStatus: 'running',actorId: actor.userId });
    expect(moved.event!.id).not.toBe(Number(initialEvent!.id));
    const rows = await database.sql`select id from public.experiment_events where experiment_id=${created!.id}`;
    expect(rows).toHaveLength(2);
  });
});
