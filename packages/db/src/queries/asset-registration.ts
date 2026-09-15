import { AssetRegistrationIntent, AssetRegistrationAdmission, AssetLibraryRegistrationOutcome,
  AssetRegistrationRefusal, EvidenceReconciliationCounts } from '@wizard-ads/shared';
import type { AuthenticatedEditorTransaction } from './authenticated-actor.js';
import type { DbHandle } from '../client.js';

/** The database locks membership and separately issued authority in the admission transaction. */
export async function admitAssetRegistration(context: AuthenticatedEditorTransaction, raw: AssetRegistrationIntent) {
  const request = AssetRegistrationIntent.parse(raw);
  const [row] = await context.sql<{ refusal: string | null }[]>`select app.admit_asset_registration(
    ${context.actor.orgId},${JSON.stringify(request)}::jsonb) as refusal`;
  if (!row) throw new Error('Asset admission receipt missing');
  const refusal = row.refusal === null ? null : AssetRegistrationRefusal.parse(row.refusal);
  return AssetRegistrationAdmission.parse({ intentId: request.id, admitted: refusal === null, refusal,
    requested: 1, admittedCount: refusal === null ? 1 : 0, refused: refusal === null ? 0 : 1 });
}

/** Reserve before any external effect; uncertain attempts cannot acquire another reservation. */
export async function reserveAssetRegistration(handle: Pick<DbHandle, 'sql'>, id: string, enabled = false) {
  if (!enabled) return { request: null, refusal: 'disabled' as const };
  return handle.sql.begin(async (sql) => {
    const rows = await sql<{ request: unknown; status: string; enabled: boolean; valid: boolean; org_id: string; profile_id: string; actor_id: string }[]>`
      select i.request,i.status,a.enabled,a.expires_at>now() as valid,i.org_id,i.profile_id,i.actor_id
      from public.asset_registration_intents i join public.asset_registration_authorities a on a.id=i.authority_id
      where i.id=${id} and a.org_id=i.org_id and a.profile_id=i.profile_id and a.actor_id=i.actor_id and a.request=i.request
      for update of i,a`;
    const row = rows[0];
    if (!row) return { request: null, refusal: 'authority_missing' as const };
    const members=await sql`select user_id from public.org_members where org_id=${row.org_id} and user_id=${row.actor_id} and role in ('owner','admin','analyst') for share`;
    const request = AssetRegistrationIntent.parse(row.request);
    const profiles=await sql`select id from public.ad_profiles where org_id=${row.org_id} and id=${row.profile_id}
      and amazon_profile_id=${request.scope.amazonProfileId} and region=${request.scope.region} for share`;
    if(profiles.length!==1) return {request:null,refusal:'scope_mismatch' as const};
    if (!row.enabled || !row.valid || members.length!==1) return { request: null, refusal: !row.enabled ? 'disabled' as const : !row.valid ? 'authority_expired' as const : 'unauthorized_actor' as const };
    if (row.status !== 'admitted') return { request: null, refusal: 'already_reserved' as const };
    const updated = await sql`update public.asset_registration_intents set status='attempting',attempted_at=now() where id=${id} returning id`;
    if (updated.length !== 1) throw new Error('Asset reservation count mismatch');
    return { request, refusal: null };
  });
}

/** Accepted provider identity and the existing read-only search consumer enter custody atomically. */
export async function settleAssetRegistration(handle: Pick<DbHandle, 'sql'>, id: string, raw: AssetLibraryRegistrationOutcome) {
  const outcome = AssetLibraryRegistrationOutcome.parse(raw);
  return handle.sql.begin(async (sql) => {
    const rows = await sql<{ org_id: string; profile_id: string; request: unknown; status: string; outcome: unknown }[]>`
      select org_id,profile_id,request,status,outcome from public.asset_registration_intents where id=${id} for update`;
    const row = rows[0]; if (!row) throw new Error('Asset intent missing');
    const request = AssetRegistrationIntent.parse(row.request);
    if (outcome.scope.region !== request.scope.region || outcome.scope.amazonProfileId !== request.scope.amazonProfileId) throw new Error('Asset outcome scope mismatch');
    if (row.status === 'accepted' || row.status === 'refused') {
      if (JSON.stringify(AssetLibraryRegistrationOutcome.parse(row.outcome)) !== JSON.stringify(outcome)) throw new Error('Asset outcome conflict');
      return { stored: 0, existing: 1, verified: 1 };
    }
    if (row.status !== 'attempting' && row.status !== 'uncertain') throw new Error('Asset outcome lacks reserved intent');
    let jobId: string | null = null;
    if (outcome.kind === 'accepted') {
      const payload = { type: 'asset-library.search', orgId: row.org_id, profileId: row.profile_id };
      await sql`insert into public.sync_jobs(org_id,profile_id,job_type,payload,dedupe_key)
        values(${row.org_id},${row.profile_id},'asset-library.search',${JSON.stringify(payload)}::jsonb,${'asset-registration:'+id}) on conflict do nothing`;
      const jobs = await sql<{ id: string }[]>`select id from public.sync_jobs where org_id=${row.org_id} and profile_id=${row.profile_id} and dedupe_key=${'asset-registration:'+id}`;
      if (jobs.length !== 1) throw new Error('Asset consumer queue readback mismatch');
      jobId = jobs[0]!.id;
    }
    const status = outcome.kind === 'accepted' ? 'accepted' : outcome.kind === 'uncertain' ? 'uncertain' : 'refused';
    await sql`update public.asset_registration_intents set status=${status},outcome=${JSON.stringify(outcome)}::jsonb,
      observed_at=now(),search_job_id=${jobId} where id=${id}`;
    const check = await sql`select id from public.asset_registration_intents where id=${id} and status=${status} and outcome=${JSON.stringify(outcome)}::jsonb`;
    if (check.length !== 1) throw new Error('Asset outcome readback mismatch');
    return { stored: 1, existing: 0, verified: check.length };
  });
}

/** Startup never repeats a possibly accepted write. Expired reservations become visible uncertainty. */
export async function reconcileAssetRegistrations(handle: Pick<DbHandle, 'sql'>, enabled = false, limit = 100) {
  if (!enabled) return EvidenceReconciliationCounts.parse({ requested: 0, attempted: 0, succeeded: 0, failed: 0, refused: 0 });
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid reconciliation bound');
  const rows = await handle.sql`with due as (select id from public.asset_registration_intents
    where status='attempting' and attempted_at<now()-interval '30 minutes' order by attempted_at limit ${limit} for update skip locked)
    update public.asset_registration_intents i set status='uncertain' from due where i.id=due.id returning i.id`;
  return EvidenceReconciliationCounts.parse({ requested: rows.length, attempted: rows.length, succeeded: rows.length, failed: 0, refused: 0 });
}

/** Read-only retries retain their original job/snapshot identity; exhausted reads stay visible. */
export async function reconcileAssetSearchWork(handle: Pick<DbHandle, 'sql'>, enabled = false, limit = 100) {
  const counts = { requested: 0, attempted: 0, succeeded: 0, failed: 0, refused: 0 };
  if (!enabled) return EvidenceReconciliationCounts.parse(counts);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid asset reconciliation bound');
  await handle.sql.begin(async (sql) => {
    const jobs = await sql<{ id: string; persisted: boolean; attempts: number; max_attempts: number }[]>`
      select j.id,j.attempts,j.max_attempts,exists(select 1 from public.asset_library_snapshots s
        where s.id=j.id and s.org_id=j.org_id and s.profile_id=j.profile_id) as persisted
      from public.sync_jobs j where j.job_type='asset-library.search' and j.status in ('failed','dead')
        and j.run_after<=now() order by j.created_at limit ${limit} for update of j skip locked`;
    for (const job of jobs) {
      counts.requested++;
      if (job.attempts>=8 || !job.persisted && job.attempts>=job.max_attempts) { counts.refused++; continue; }
      counts.attempted++;
      const rows = await sql`update public.sync_jobs set status='queued',claimed_by=null,claimed_at=null,claim_token=null,
        run_after=now(),max_attempts=greatest(max_attempts,attempts+1) where id=${job.id} returning id`;
      if (rows.length !== 1) throw new Error('Asset read recovery count mismatch');
      counts.succeeded++;
    }
  });
  return EvidenceReconciliationCounts.parse(counts);
}
