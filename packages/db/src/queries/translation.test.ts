import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { withAuthenticatedOrgEditor, withAuthenticatedReadSnapshot } from './authenticated-actor.js';
import { completeTranslationAttempt, listTargetTranslations, readTranslationAttempt, requestTargetTranslation, retryTargetTranslation } from './translation.js';

describe('target translation authority and queue', () => {
  let db: TestDatabase;
  const actors = [0, 1].map(() => ({ orgId: '', userId: randomUUID(), profileId: '' }));
  beforeAll(async () => {
    db = await createTestDatabase('translations');
    for (const [index, actor] of actors.entries()) {
      const [tenant] = await db.sql<{ id: string }[]>`select app.seed_tenant_fixture(${'translation-' + index}, ${actor.userId}, 'owner') as id`;
      actor.orgId = tenant!.id;
      const [profile] = await db.sql<{ id: string }[]>`select id from public.ad_profiles where org_id=${actor.orgId} limit 1`;
      actor.profileId = profile!.id;
    }
  }, 180_000);
  afterAll(async () => { await db?.drop(); });
  it('atomically queues one request, reuses its identity, and fences completion after retry', async () => {
    const a = actors[0]!;
    const request = { profileId: a.profileId, originalText: '  Synthetic exact wording  ', language: 'de' };
    const first = await withAuthenticatedOrgEditor(db, { orgId: a.orgId, userId: a.userId }, (tx) => requestTargetTranslation(tx, request));
    const reused = await withAuthenticatedOrgEditor(db, { orgId: a.orgId, userId: a.userId }, (tx) => requestTargetTranslation(tx, request));
    expect(reused).toEqual(first);
    const jobs = await db.sql<{ payload: unknown }[]>`select payload from public.sync_jobs where org_id=${a.orgId} and job_type='translation.request'`;
    expect(jobs).toHaveLength(1);
    const old = { type: 'translation.request' as const, orgId: a.orgId, profileId: a.profileId, translationId: first.id, requestId: first.provenance.requestId };
    const next = await withAuthenticatedOrgEditor(db, { orgId: a.orgId, userId: a.userId }, (tx) => retryTargetTranslation(tx, { profileId: a.profileId, translationId: first.id }));
    expect(next.provenance.requestId).not.toBe(first.provenance.requestId);
    expect(await readTranslationAttempt(db, old)).toBeNull();
    expect(await completeTranslationAttempt(db, old, { status: 'unavailable', text: null, reason: 'provider not configured' }, 'not-configured')).toBe(0);
    expect(await completeTranslationAttempt(db, { ...old, requestId: next.provenance.requestId }, { status: 'unavailable', text: null, reason: 'provider not configured' }, 'not-configured')).toBe(1);
    const saved = await readTranslationAttempt(db, { ...old, requestId: next.provenance.requestId });
    expect(saved?.originalText).toBe(request.originalText);
    expect(saved?.result.status).toBe('unavailable');
    expect(await db.sql`select id from public.sync_jobs where org_id=${a.orgId} and job_type='translation.request'`).toHaveLength(2);
  });
  it('refuses foreign agency reads, profile binding and retry', async () => {
    const a = actors[0]!; const b = actors[1]!;
    const row = await withAuthenticatedOrgEditor(db, { orgId: a.orgId, userId: a.userId }, (tx) => requestTargetTranslation(tx, { profileId: a.profileId, originalText: 'Private synthetic text' }));
    expect(await withAuthenticatedReadSnapshot(db, { orgId: b.orgId, userId: b.userId }, (tx) => listTargetTranslations(tx, a.orgId, a.profileId))).toEqual([]);
    await expect(withAuthenticatedOrgEditor(db, { orgId: b.orgId, userId: b.userId }, (tx) => requestTargetTranslation(tx, { profileId: a.profileId, originalText: 'Forbidden' }))).rejects.toThrow();
    await expect(withAuthenticatedOrgEditor(db, { orgId: b.orgId, userId: b.userId }, (tx) => retryTargetTranslation(tx, { profileId: b.profileId, translationId: row.id }))).rejects.toThrow();
  });
  it('refuses viewer admission and direct result modification', async () => {
    const a = actors[0]!; const viewer = { orgId: a.orgId, userId: randomUUID() };
    await db.sql`insert into auth.users(id) values(${viewer.userId})`;
    await db.sql`insert into public.org_members(org_id,user_id,role) values(${viewer.orgId},${viewer.userId},'viewer')`;
    await expect(withAuthenticatedOrgEditor(db, viewer, (tx) => requestTargetTranslation(tx, { profileId: a.profileId, originalText: 'Forbidden' }))).rejects.toThrow();
  });
  it('retains different languages and exact originals as different cache identities', async () => {
    const a = actors[0]!; const ids = [];
    for (const [originalText, language] of [['Synthetic text', 'en'], ['Synthetic text', 'fr'], ['synthetic text', 'en']] as const) {
      ids.push((await withAuthenticatedOrgEditor(db, { orgId: a.orgId, userId: a.userId }, (tx) => requestTargetTranslation(tx, { profileId: a.profileId, originalText, language }))).id);
    }
    expect(new Set(ids).size).toBe(3);
  });
});
