import { createHash } from 'node:crypto';
import {
  SpWriteActor, SpWriteAdmission, SpWritePreview, SpWriteRecordedPreview, SpWriteRecordedPreviewRequest,
  type SpWritePreviewFreshnessReason,
} from '@wizard-ads/shared/sp-write-application';
import {
  SpCanonicalDecimal, SpWriteAuthorizationReceipt, spWritePlanBinding,
  verifySpWriteInversePair, verifySpWritePlanFingerprints,
} from '@wizard-ads/shared/sp-writes';
import type { DbHandle, QuerySql } from '../client.js';
import { SpWriteApplicationError } from './sp-write-errors.js';
import { buildSpWriteLegacyPreview } from './sp-write-plan-builder.js';
import { loadSpWritePreviewEvidence } from './sp-write-preview-evidence.js';

const hasher = { algorithm: 'sha256' as const, digest: (value: string) => createHash('sha256').update(value).digest('hex') };

function canonicalAmount(raw: string | null): string | null {
  if (raw === null || !/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const [whole = '', fraction = ''] = raw.split('.');
  const integer = whole.replace(/^0+(?=\d)/, '');
  const tail = fraction.replace(/0+$/, '');
  const parsed = SpCanonicalDecimal.safeParse(tail ? `${integer}.${tail}` : integer);
  return parsed.success ? parsed.data : null;
}

async function priorAdmission(sql: QuerySql, preview: SpWritePreview): Promise<SpWriteAdmission | null> {
  const plan = preview.plan;
  const rows = await sql<{ artifact_text: string; execution_id: string; approval_id: string; generation: string; queued: boolean }[]>`
    select receipt.artifact_text, child.execution_id::text, child.approval_id::text, child.generation::text,
      exists(select 1 from public.sp_write_execution_requests request
        where request.org_id = child.org_id and request.profile_id = child.profile_id
          and request.execution_id = child.execution_id and request.plan_id = child.plan_id
          and request.approval_id = child.approval_id and request.generation = child.generation) as queued
    from public.sp_write_cycle_plans child
    join public.sp_write_authorization_receipts receipt
      on receipt.org_id = child.org_id and receipt.profile_id = child.profile_id
      and receipt.execution_id = child.execution_id and receipt.plan_id = child.receipt_plan_id
      and receipt.approval_id = child.approval_id and receipt.generation = child.generation
    where child.org_id = ${plan.orgId}::uuid and child.profile_id = ${plan.profileId}::uuid
      and child.plan_id = ${plan.id}::uuid
  `;
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new SpWriteApplicationError('identity_conflict');
  const row = rows[0]!;
  const receipt = SpWriteAuthorizationReceipt.parse(JSON.parse(row.artifact_text));
  if (receipt.executionId !== row.execution_id || receipt.approvalId !== row.approval_id
    || receipt.generation !== row.generation
    || ![receipt.plan, receipt.preapprovedInversePlan].some((binding) =>
      JSON.stringify(binding) === JSON.stringify(preview.binding))) {
    throw new SpWriteApplicationError('identity_conflict');
  }
  return SpWriteAdmission.parse({ kind: row.queued ? 'queued' : 'approved_pending_start',
    operation: { executionId: receipt.executionId, planId: plan.id },
    approvalId: receipt.approvalId, approvalRequestId: receipt.approvalRequestId });
}

/** Read an existing preview in one snapshot. This transaction cannot record or enqueue anything. */
export async function readRecordedSpWritePreview(
  handle: Pick<DbHandle, 'sql'>, rawActor: SpWriteActor, rawRequest: SpWriteRecordedPreviewRequest,
): Promise<SpWriteRecordedPreview> {
  const actor = SpWriteActor.parse(rawActor);
  const request = SpWriteRecordedPreviewRequest.parse(rawRequest);
  return handle.sql.begin('isolation level repeatable read read only', async (sql) => {
    const rows = await sql<{ artifact_text: string; label: string; checked_at: string; expired: boolean;
      profile_matches: boolean; grant_id: string | null; grant_version: string | null; grant_matches: boolean;
      gate_enabled: boolean }[]>`
      select plan.artifact_text, coalesce(profile.account_name, profile.amazon_profile_id) as label,
        app.sp_write_instant(transaction_timestamp()) as checked_at,
        transaction_timestamp() >= plan.expires_at as expired,
        coalesce(profile.sync_enabled and connection.status = 'active'
          and profile.amazon_profile_id = plan.amazon_profile_id and profile.connection_id = plan.connection_id
          and profile.region = plan.region and profile.currency_code = plan.currency_code, false) as profile_matches,
        grant_version.grant_id::text, grant_version.version_id::text as grant_version,
        coalesce(grant_version.enabled and grant_version.amazon_profile_id = plan.amazon_profile_id
          and grant_version.connection_id = plan.connection_id and grant_version.region = plan.region
          and grant_version.marketplace_id = plan.marketplace_id and grant_version.currency_code = plan.currency_code
          and grant_version.api_dialect = plan.api_dialect, false) as grant_matches,
        exists(select 1 from public.sp_write_environment_gate_head head
          join public.sp_write_environment_gate_versions version on version.version_id = head.version_id
          where version.enabled) as gate_enabled
      from public.sp_write_plans plan
      join public.ad_profiles profile on profile.org_id = plan.org_id and profile.id = plan.profile_id
      left join public.ads_connections connection on connection.org_id = profile.org_id and connection.id = profile.connection_id
      left join public.sp_write_profile_grant_heads grant_head
        on grant_head.org_id = plan.org_id and grant_head.profile_id = plan.profile_id
      left join public.sp_write_profile_grant_versions grant_version
        on grant_version.org_id = grant_head.org_id and grant_version.profile_id = grant_head.profile_id
          and grant_version.grant_id = grant_head.grant_id and grant_version.version_id = grant_head.version_id
      where plan.org_id = ${actor.orgId}::uuid and plan.profile_id = ${request.profileId}::uuid
        and plan.plan_id = ${request.planId}::uuid
        and exists(select 1 from public.org_members membership
          where membership.org_id = plan.org_id and membership.user_id = ${actor.userId}::uuid
            and membership.role in ('owner', 'admin'))
    `;
    if (rows.length === 0) throw new SpWriteApplicationError('not_found');
    if (rows.length !== 1) throw new SpWriteApplicationError('identity_conflict');
    const row = rows[0]!;
    const plan = verifySpWritePlanFingerprints(JSON.parse(row.artifact_text), hasher);
    if (plan.orgId !== actor.orgId || plan.profileId !== request.profileId || plan.id !== request.planId) {
      throw new SpWriteApplicationError('identity_conflict');
    }
    const reasons = new Set<SpWritePreviewFreshnessReason>();
    if (row.expired) reasons.add('expired');
    if (!row.profile_matches) reasons.add('profile_changed');
    if (!row.grant_matches) reasons.add('grant_changed');
    if (!row.gate_enabled) reasons.add('gate_disabled');
    const source = await loadSpWritePreviewEvidence(sql, { orgId: plan.orgId, profileId: plan.profileId,
      planId: plan.source.kind === 'inverse_execution' ? plan.source.sourcePlanId : plan.id });
    if (source === null) throw new SpWriteApplicationError('identity_conflict');
    let preview: SpWritePreview;
    if (plan.source.kind === 'inverse_execution') {
      verifySpWriteInversePair(source.plan, plan, hasher);
      const [original] = await sql<{ observed: boolean }[]>`
        select exists(select 1 from public.sp_write_cycle_plans cycle
          where cycle.org_id = ${plan.orgId}::uuid and cycle.profile_id = ${plan.profileId}::uuid
            and cycle.execution_id = ${plan.source.sourceExecutionId}::uuid
            and cycle.plan_id = ${plan.source.sourcePlanId}::uuid)
          and (select count(*) from public.sp_write_observations observation
            where observation.org_id = ${plan.orgId}::uuid and observation.profile_id = ${plan.profileId}::uuid
              and observation.execution_id = ${plan.source.sourceExecutionId}::uuid
              and observation.plan_id = ${plan.source.sourcePlanId}::uuid
              and observation.outcome = 'observed_requested') = ${plan.counts.providerRows} as observed
      `;
      if (!original?.observed) reasons.add('source_changed');
      preview = SpWritePreview.parse({ plan, binding: spWritePlanBinding(plan), evidence: null });
    } else {
      preview = SpWritePreview.parse({ ...source, binding: spWritePlanBinding(plan) });
      if (source.evidence.schemaVersion === 'openspell.sp-write-preview-evidence.v1') {
        // Reuse the query-only source builder; its transient timestamps are discarded.
        // The immutable saved evidence remains the only preview returned to callers.
        try {
          const current = await buildSpWriteLegacyPreview(sql, actor.orgId, {
            requestId: plan.id, profileId: plan.profileId, applyBatchId: plan.source.applyBatchId,
          });
          if (JSON.stringify(current.evidence) !== JSON.stringify(source.evidence)) reasons.add('source_changed');
        } catch (error) {
          if (!(error instanceof SpWriteApplicationError) || error.code === 'outcome_unknown') throw error;
          reasons.add('source_changed');
        }
        const [intact] = await sql<{ matches: boolean }[]>`
          select count(*) = ${source.evidence.provenance.rows.length} and bool_and(
            recommendation.status = 'exported' and recommendation.export_batch_id = apply_row.batch_id
            and recommendation.proposal_revision_id is not distinct from apply_row.proposal_revision_id)
          as matches
          from public.apply_rows apply_row
          join public.recommendations recommendation on recommendation.org_id = apply_row.org_id
            and recommendation.profile_id = apply_row.profile_id and recommendation.id = apply_row.recommendation_id
          where apply_row.org_id = ${plan.orgId}::uuid and apply_row.profile_id = ${plan.profileId}::uuid
            and apply_row.batch_id = ${plan.source.applyBatchId}::uuid
        `;
        if (!intact?.matches) reasons.add('source_changed');
      }
    }
    // A forward approval binds the frozen grant version. A newly approved inverse
    // uses the current grant, as the existing inverse admission contract specifies.
    if (plan.direction === 'forward' && (row.grant_id !== source.evidence.guardrails.profileGrantId
      || row.grant_version !== source.evidence.guardrails.profileGrantVersion)) reasons.add('grant_changed');

    const keywordIds = plan.actions.flatMap((action) => action.routeKey === 'sp.v3.keywords.update'
      && action.changes.bid !== undefined && Object.keys(action.changes).length === 1 ? [action.entity.keywordId] : []);
    const keywords = await sql<{ amazon_id: string; name: string | null; bid: string | null;
      state: string; synced_at: string | null; available: boolean }[]>`
      select amazon_id, name, bid::text, state::text,
        case when synced_at is null then null else app.sp_write_instant(synced_at) end as synced_at,
        (ad_product = 'SP' and deleted_at is null and state in ('enabled', 'paused')) as available
      from public.keywords where org_id = ${plan.orgId}::uuid and profile_id = ${plan.profileId}::uuid
        and amazon_id = any(${keywordIds}::text[])
    `;
    const byKeyword = new Map(keywords.map((keyword) => [keyword.amazon_id, keyword]));
    const currentRows: SpWriteRecordedPreview['currentRows'] = plan.actions.map((action) => {
      if (action.routeKey !== 'sp.v3.keywords.update' || action.changes.bid === undefined
        || Object.keys(action.changes).length !== 1) {
        reasons.add('unsupported_action');
        return { actionId: action.actionId, entityName: null, syncedAt: null, observation: null };
      }
      const keyword = byKeyword.get(action.entity.keywordId);
      const amount = canonicalAmount(keyword?.bid ?? null);
      if (!keyword?.available || keyword.synced_at === null || amount === null
        || !['enabled', 'paused'].includes(keyword.state)) {
        reasons.add('entity_unavailable');
        return { actionId: action.actionId, entityName: keyword?.name ?? null,
          syncedAt: keyword?.synced_at ?? null, observation: null };
      }
      if (amount !== action.changes.bid.expected.amount) reasons.add('current_value_changed');
      return { actionId: action.actionId, entityName: keyword.name, syncedAt: keyword.synced_at,
        observation: { routeKey: action.routeKey, actionId: action.actionId, actionFingerprint: action.fingerprint,
          amazonEntityId: action.entity.keywordId,
          values: { bid: { amount, currencyCode: plan.providerScope.currencyCode },
            state: keyword.state === 'enabled' ? 'enabled' : 'paused' } } };
    });
    return SpWriteRecordedPreview.parse({ preview,
      profile: { id: plan.profileId, label: row.label, currencyCode: plan.providerScope.currencyCode },
      currentRows, freshness: { checkedAt: row.checked_at,
        status: reasons.has('entity_unavailable') || reasons.has('unsupported_action') ? 'unavailable'
          : reasons.size > 0 ? 'stale' : 'current', reasons: [...reasons] },
      admission: await priorAdmission(sql, preview),
    });
  });
}
