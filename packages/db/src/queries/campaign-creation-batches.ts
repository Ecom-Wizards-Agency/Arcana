import { createHash } from 'node:crypto';
import {
  CampaignCreationBatch, CampaignCreationBatchRequest, CampaignCreationRefusalCode, CampaignCreationProviderScope,
  CampaignCreationAdmissionValidation, CampaignBuilderCheck, CampaignBuilderValidation, CampaignCreationRetryReviewRequest,
  spMarketplaceScopeForCountry, Uuid, Region, verifyCampaignCreationPlanFingerprints, type CampaignCreationPlan, type CampaignDraft,
} from '@wizard-ads/shared';
import type { QuerySql } from '../client.js';
import type { AuthenticatedEditorTransaction, AuthenticatedReadSnapshot } from './authenticated-actor.js';
import { readCampaignDraft } from './campaign-drafts.js';

type Context = AuthenticatedEditorTransaction | AuthenticatedReadSnapshot;
const hasher = { algorithm: 'sha256' as const, digest: (text: string) => createHash('sha256').update(text).digest('hex') };
export class CampaignCreationAdmissionError extends Error {
  constructor(readonly code: CampaignCreationRefusalCode) { super(`Campaign creation refused: ${code}`); }
}

/** SQL owns RLS and row scope; the parser asserts every frozen row was loaded. */
export async function loadCampaignCreationBatch(sql: QuerySql, orgId: string, profileId: string, batchId: string): Promise<CampaignCreationBatch | null> {
  Uuid.parse(orgId); Uuid.parse(profileId); Uuid.parse(batchId);
  const rows = await sql<{ artifact: unknown; node_count: number; loaded: number }[]>`
    select b.artifact || jsonb_build_object('nodes',coalesce(jsonb_agg(jsonb_build_object(
      'nodeId',n.node_id,'nodeFingerprint',n.node_fingerprint,'intent',n.intent,'result',n.result,
      'observation',n.observation,'refusal',n.refusal,'observations',coalesce((select jsonb_agg(o.artifact order by o.recorded_at)
        from public.campaign_creation_observations o where o.org_id=n.org_id and o.profile_id=n.profile_id
          and o.batch_id=n.batch_id and o.node_id=n.node_id),'[]'::jsonb)) order by n.ordinal) filter(where n.node_id is not null),'[]'::jsonb)) as artifact,
      b.node_count,count(n.node_id)::integer as loaded
    from public.campaign_creation_batches b left join public.campaign_creation_batch_nodes n
      on n.batch_id=b.id and n.org_id=b.org_id and n.profile_id=b.profile_id
    where b.org_id=${orgId}::uuid and b.profile_id=${profileId}::uuid and b.id=${batchId}::uuid group by b.id
  `;
  if (rows.length === 0) return null;
  if (rows.length !== 1 || rows[0]!.node_count !== rows[0]!.loaded) throw new Error('Creation parsed/loaded count mismatch');
  const batch = CampaignCreationBatch.parse(rows[0]!.artifact);
  verifyCampaignCreationPlanFingerprints(batch.plan, hasher);
  if (batch.id !== batchId || batch.plan.orgId !== orgId || batch.plan.profileId !== profileId || batch.nodes.length !== rows[0]!.loaded) {
    throw new Error('Creation batch identity mismatch');
  }
  return batch;
}
export function readCampaignCreationBatch(context: Context, profileId: string, batchId: string) {
  return loadCampaignCreationBatch(context.sql, context.actor.orgId, profileId, batchId);
}
/** Read only this admission identity; unrelated profile history is not part of approval. */
export async function findCampaignCreationAdmission(context: Context, raw: CampaignCreationBatchRequest): Promise<CampaignCreationBatch | null> {
  const request = CampaignCreationBatchRequest.parse(raw);
  const rows = await context.sql<{ id: string }[]>`select id from public.campaign_creation_batches
    where org_id=${context.actor.orgId}::uuid and profile_id=${request.profileId}::uuid and draft_id=${request.draftId}::uuid
      and artifact->'plan'->>'fingerprint'=${request.planFingerprint}
      and parent_batch_id is not distinct from ${request.action === 'retry' ? request.parentBatchId : null}::uuid`;
  if (rows.length > 1) throw new Error('Creation admission identity is not unique');
  if (!rows[0]) return null;
  const batch = await readCampaignCreationBatch(context, request.profileId, rows[0].id);
  if (!batch) throw new Error('Creation admission count mismatch');
  if (request.action === 'retry' && JSON.stringify(batch.lineage?.nodeIds) !== JSON.stringify(request.nodeIds)) {
    throw new CampaignCreationAdmissionError('retry_not_allowed');
  }
  return batch;
}
export async function listCampaignCreationBatches(context: Context, profileId: string): Promise<CampaignCreationBatch[]> {
  Uuid.parse(profileId);
  const rows = await context.sql<{ id: string }[]>`select id from public.campaign_creation_batches
    where org_id=${context.actor.orgId}::uuid and profile_id=${profileId}::uuid order by admitted_at desc,id`;
  const batches: CampaignCreationBatch[] = [];
  for (const row of rows) {
    const batch = await readCampaignCreationBatch(context, profileId, row.id);
    if (!batch) throw new Error('Creation list count mismatch');
    batches.push(batch);
  }
  if (batches.length !== rows.length) throw new Error('Creation list count mismatch');
  return batches;
}

/** Current profile evidence is frozen when saving, never filled from the submitted plan. */
export async function readCampaignCreationProviderScope(context: Context, profileId: string): Promise<CampaignCreationProviderScope | null> {
  Uuid.parse(profileId);
  const rows = await context.sql<{ amazon_profile_id: string; connection_id: string | null; region: string;
    currency_code: string; country_code: string; account_type: string | null }[]>`
    select amazon_profile_id,connection_id,region::text,currency_code,country_code,account_type::text from public.ad_profiles
    where org_id=${context.actor.orgId}::uuid and id=${profileId}::uuid`;
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  const marketplace = spMarketplaceScopeForCountry(row.country_code, Region.parse(row.region), row.currency_code);
  const parsed = CampaignCreationProviderScope.safeParse({ amazonProfileId: row.amazon_profile_id, connectionId: row.connection_id,
    region: row.region, currencyCode: row.currency_code, marketplaceId: marketplace?.marketplaceId, accountType: row.account_type });
  return parsed.success ? parsed.data : null;
}
export async function readCampaignCreationGate(context: Context, plan: CampaignCreationPlan): Promise<{
  available: boolean; reason: CampaignCreationRefusalCode | null;
}> {
  if (plan.adProduct !== 'SP') return { available: false, reason: 'plan_not_sponsored_products' };
  if (plan.schemaVersion !== 'openspell.campaign-creation-plan.v2') return { available: false, reason: 'executor_unavailable' };
  if (plan.orgId !== context.actor.orgId) return { available: false, reason: 'not_found' };
  const rows = await context.sql<{ gate: { reason: unknown } }[]>`select app.campaign_creation_gate(
    ${context.actor.orgId}::uuid,${plan.profileId}::uuid,${JSON.stringify(plan.providerScope)}::jsonb) as gate`;
  if (rows.length !== 1) return { available: false, reason: 'executor_unavailable' };
  const reason = rows[0]!.gate.reason === null ? null : CampaignCreationRefusalCode.parse(rows[0]!.gate.reason);
  return { available: reason === null, reason };
}

/**
 * Record fresh evidence on an approved draft before a separate retry or recovery confirmation is
 * shown. The revision advances, so admission can bind exactly the evidence displayed. Nothing is queued.
 */
export async function recordCampaignCreationRetryReview(context: AuthenticatedEditorTransaction, raw: CampaignCreationRetryReviewRequest,
  rawValidation: CampaignBuilderValidation): Promise<CampaignDraft> {
  const request = CampaignCreationRetryReviewRequest.parse(raw);
  const validation = CampaignBuilderValidation.parse(rawValidation);
  const rows = await context.sql<{ result: { reason?: unknown; revision?: unknown } }[]>`select app.record_campaign_creation_review(
    ${context.actor.orgId}::uuid,${JSON.stringify(request)}::jsonb,${JSON.stringify(validation)}::jsonb) as result`;
  if (rows.length !== 1) throw new Error('Creation review count mismatch');
  const result = rows[0]!.result;
  if (result.reason !== undefined) throw new CampaignCreationAdmissionError(CampaignCreationRefusalCode.parse(result.reason));
  const draft = await readCampaignDraft(context, request.profileId, request.draftId);
  if (!draft || draft.revision !== result.revision || draft.validation === null
    || JSON.stringify(CampaignBuilderValidation.parse(draft.validation)) !== JSON.stringify(validation)) {
    throw new Error('Recorded creation review unavailable');
  }
  return draft;
}

/**
 * Call with the persisted review evidence displayed for the requested revision. SQL refuses any
 * other evidence and any evidence older than its five-minute window; it never refreshes it.
 */
export async function admitCampaignCreation(context: AuthenticatedEditorTransaction, raw: CampaignCreationBatchRequest,
  displayedValidation: CampaignCreationAdmissionValidation): Promise<CampaignCreationBatch> {
  const request = CampaignCreationBatchRequest.parse(raw);
  if (displayedValidation.checks.some((check) => check.blocking)) throw new CampaignCreationAdmissionError('blocking_check');
  const parsed = CampaignCreationAdmissionValidation.safeParse(displayedValidation);
  if (!parsed.success) throw new CampaignCreationAdmissionError('freshness_not_current');
  const validation = parsed.data;
  if (!CampaignBuilderCheck.shape.id.options.every((id) => validation.checks.filter((check) => check.id === id).length === 1)) {
    throw new CampaignCreationAdmissionError('freshness_not_current');
  }
  const rows = await context.sql<{ result: { reason?: unknown; batchId?: unknown } }[]>`select app.admit_campaign_creation(
    ${context.actor.orgId}::uuid,${JSON.stringify(request)}::jsonb,${JSON.stringify(validation)}::jsonb) as result`;
  if (rows.length !== 1) throw new Error('Creation admission count mismatch');
  const result = rows[0]!.result;
  if (result.reason !== undefined) throw new CampaignCreationAdmissionError(CampaignCreationRefusalCode.parse(result.reason));
  const batch = await readCampaignCreationBatch(context, request.profileId, Uuid.parse(result.batchId));
  if (!batch) throw new Error('Admitted creation unavailable');
  return batch;
}
