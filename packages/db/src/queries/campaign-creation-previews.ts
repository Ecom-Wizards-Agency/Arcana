import { createHash } from 'node:crypto';
import { CampaignCreationPlanV2, verifyCampaignCreationPlanFingerprints } from '@wizard-ads/shared';
import { CampaignCreationApprovalRequest, CampaignCreationApprovalSource,
  type CampaignCreationPreviewErrorCode } from '@wizard-ads/shared/campaign-creation-approval';
import { SpWriteActor } from '@wizard-ads/shared/sp-write-application';
import type { DbHandle } from '../client.js';
import { withAuthenticatedActor } from './authenticated-actor.js';

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const hasher = { algorithm: 'sha256' as const, digest };

export class CampaignCreationPreviewError extends Error {
  constructor(readonly code: CampaignCreationPreviewErrorCode) {
    super('Campaign preview is unavailable');
    this.name = 'CampaignCreationPreviewError';
  }
}

function failure(error: unknown): CampaignCreationPreviewError {
  if (error instanceof CampaignCreationPreviewError) return error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  if (code === '23505') return new CampaignCreationPreviewError('identity_conflict');
  if (code === '42501') return new CampaignCreationPreviewError('authorization_refused');
  if (typeof code === 'string' && code.startsWith('22')) return new CampaignCreationPreviewError('invalid_request');
  return new CampaignCreationPreviewError('unavailable');
}

/** Save an already frozen plan; no public generator, approval, queue or provider call. */
export async function recordCampaignCreationPreview(
  handle: Pick<DbHandle, 'sql'>, rawActor: SpWriteActor, rawPlan: CampaignCreationPlanV2,
): Promise<CampaignCreationApprovalRequest> {
  let actor: SpWriteActor;
  let plan: CampaignCreationPlanV2;
  try {
    actor = SpWriteActor.parse(rawActor);
    plan = CampaignCreationPlanV2.parse(verifyCampaignCreationPlanFingerprints(rawPlan, hasher));
    if (plan.orgId !== actor.orgId) throw new Error('scope mismatch');
  } catch { throw new CampaignCreationPreviewError('invalid_request'); }
  // Parse/copy before the asynchronous transaction so caller mutation cannot change the record.
  const artifactText = JSON.stringify(plan);
  try {
    return await withAuthenticatedActor(handle, actor, async (sql) => {
      const rows = await sql<{ identity: unknown }[]>`
        select app.record_campaign_creation_preview(${artifactText}) as identity
      `;
      if (rows.length !== 1) throw new CampaignCreationPreviewError('unavailable');
      const identity = CampaignCreationApprovalRequest.parse(rows[0]!.identity);
      if (identity.profileId !== plan.profileId || identity.planId !== plan.id) {
        throw new CampaignCreationPreviewError('unavailable');
      }
      return identity;
    });
  } catch (error) { throw failure(error); }
}

/** Actual owned record read. Every current check is unavailable until durable sources exist. */
export async function readRecordedCampaignCreationPreview(
  handle: Pick<DbHandle, 'sql'>, rawActor: SpWriteActor, rawRequest: CampaignCreationApprovalRequest,
): Promise<CampaignCreationApprovalSource> {
  let actor: SpWriteActor;
  let request: CampaignCreationApprovalRequest;
  try {
    actor = SpWriteActor.parse(rawActor);
    request = CampaignCreationApprovalRequest.parse(rawRequest);
  } catch { throw new CampaignCreationPreviewError('invalid_request'); }
  try {
    const result = await handle.sql.begin('isolation level repeatable read read only', async (sql) => {
      await sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: actor.userId, role: 'authenticated' })}, true)`;
      await sql`set local role authenticated`;
      const rows = await sql<{ org_id: string; profile_id: string; plan_id: string; artifact_text: string;
        artifact_sha256: string; label: string; recorded_at: string; checked_at: string }[]>`
        select saved.org_id::text, saved.profile_id::text, saved.plan_id::text,
          saved.artifact_text, saved.artifact_sha256,
          coalesce(profile.account_name, profile.amazon_profile_id) as label,
          to_char(saved.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as recorded_at,
          to_char(transaction_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as checked_at
        from public.campaign_creation_previews saved
        join public.ad_profiles profile on profile.org_id = saved.org_id and profile.id = saved.profile_id
        where saved.org_id = ${actor.orgId}::uuid and saved.profile_id = ${request.profileId}::uuid
          and saved.plan_id = ${request.planId}::uuid
          and exists (select 1 from public.org_members membership
            where membership.org_id = saved.org_id and membership.user_id = ${actor.userId}::uuid
              and membership.role in ('owner','admin'))
      `;
      if (rows.length === 0) throw new CampaignCreationPreviewError('not_found');
      if (rows.length !== 1) throw new CampaignCreationPreviewError('unavailable');
      const row = rows[0]!;
      if (digest(row.artifact_text) !== row.artifact_sha256) throw new CampaignCreationPreviewError('unavailable');
      const plan = verifyCampaignCreationPlanFingerprints(JSON.parse(row.artifact_text), hasher);
      const recordedAt = Date.parse(row.recorded_at);
      const checkedAt = Date.parse(row.checked_at);
      if (plan.orgId !== row.org_id || plan.orgId !== actor.orgId || plan.profileId !== row.profile_id
        || plan.profileId !== request.profileId || plan.id !== row.plan_id || plan.id !== request.planId
        || !Number.isFinite(recordedAt) || !Number.isFinite(checkedAt)
        || recordedAt < Date.parse(plan.frozenAt)
        || recordedAt > checkedAt) throw new CampaignCreationPreviewError('unavailable');
      return { value: CampaignCreationApprovalSource.parse({
        plan, profile: { id: plan.profileId, label: row.label }, checkedAt: row.checked_at,
        current: { orgId: plan.orgId, profileId: plan.profileId, planFingerprint: plan.fingerprint,
          // Profiles have no independently observed marketplace ID. Never copy it from the saved plan.
          providerScope: null,
          checks: plan.nodes.map((node) => ({ nodeId: node.nodeId, nodeFingerprint: node.fingerprint,
            result: 'unknown', reason: 'unavailable', checkedAt: null, validUntil: null })),
          assets: plan.nodes.filter((node) => node.kind === 'asset.require_existing').map((node) => ({
            nodeId: node.nodeId, observation: null, moderation: 'unknown' })),
        }, admission: { kind: 'unavailable' },
      }) };
    });
    return result.value;
  } catch (error) { throw failure(error); }
}
