import { createHash } from 'node:crypto';
import { CoordinatedMethodInput } from '@wizard-ads/shared';
import {
  SpWriteActor, SpWriteAdmission, SpWritePreview, SpWriteRecordedPreview, SpWriteRecordedPreviewRequest,
  type SpWritePreviewFreshnessReason,
} from '@wizard-ads/shared/sp-write-application';
import {
  SpCanonicalDecimal, SpCompleteCampaignBiddingState, SpWriteAuthorizationReceipt, spWritePlanBinding,
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
  return handle.sql.begin('isolation level repeatable read read only', (sql) =>
    loadRecordedSpWritePreview(sql, actor, request));
}

export async function loadRecordedSpWritePreview(
  sql: QuerySql, actor: SpWriteActor, request: SpWriteRecordedPreviewRequest,
): Promise<SpWriteRecordedPreview> {
    const rows = await sql<{ artifact_text: string; label: string; checked_at: string; expired: boolean;
      profile_matches: boolean; grant_id: string | null; grant_version: string | null; grant_matches: boolean;
      gate_enabled: boolean }[]>`
      select plan.artifact_text, coalesce(profile.account_name, profile.amazon_profile_id) as label,
        to_char(transaction_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as checked_at,
        transaction_timestamp() >= plan.expires_at as expired,
        coalesce(profile.sync_enabled and connection.status = 'active'
          and profile.amazon_profile_id = plan.amazon_profile_id and profile.connection_id = plan.connection_id
          and profile.region = plan.region and profile.currency_code = plan.currency_code, false) as profile_matches,
        grant_version.grant_id::text, grant_version.version_id::text as grant_version,
        coalesce(grant_version.enabled and grant_version.amazon_profile_id = plan.amazon_profile_id
          and grant_version.connection_id = plan.connection_id and grant_version.region = plan.region
          and grant_version.marketplace_id = plan.marketplace_id and grant_version.currency_code = plan.currency_code
          and grant_version.api_dialect = plan.api_dialect, false) as grant_matches,
        app.sp_write_environment_enabled(plan.org_id, plan.profile_id) as gate_enabled
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
      if (source.evidence.schemaVersion === 'openspell.sp-write-preview-evidence.v1'
        || source.evidence.schemaVersion === 'openspell.sp-write-preview-evidence.v3') {
        if (source.evidence.provenance.rows.some((row) => row.method === undefined)) reasons.add('source_changed');
        // Reuse the query-only source builder; its transient timestamps are discarded.
        // The immutable saved evidence remains the only preview returned to callers.
        try {
          const current = await buildSpWriteLegacyPreview(sql, actor.orgId, {
            requestId: plan.id, profileId: plan.profileId, applyBatchId: plan.source.applyBatchId,
            ...(plan.source.forwardRowIds === undefined ? {} : { forwardRowIds: plan.source.forwardRowIds }),
            ...(plan.source.retryOrigin === undefined ? {} : { retryOrigin: plan.source.retryOrigin }),
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
            and (${plan.source.forwardRowIds ?? null}::uuid[] is null or apply_row.id = any(${plan.source.forwardRowIds ?? null}::uuid[]))
        `;
        if (!intact?.matches) reasons.add('source_changed');
      }
    }
    if (plan.schemaVersion === 'openspell.sp-write-plan.v1' && plan.direction === 'forward' && plan.source.kind === 'apply_batch') {
      const parentPlanId = plan.source.retryOrigin?.planId ?? null;
      const ids = plan.actions.flatMap((action) => action.sources.flatMap((item) => item.kind === 'apply_row' ? [item.applyRowId] : []));
      const [ownership] = await sql<{ current: boolean }[]>`
        with recursive ancestors(source_row_id,plan_id) as (
          select unnest(${ids}::uuid[]),${parentPlanId}::uuid where ${parentPlanId}::uuid is not null
          union
          select a.source_row_id,e.parent_plan_id from ancestors a join app.sp_write_forward_lineage e
            on e.org_id=${plan.orgId}::uuid and e.profile_id=${plan.profileId}::uuid
              and e.source_row_id=a.source_row_id and e.retry_plan_id=a.plan_id
        ) select not exists(select 1 from public.sp_write_cycle_plans c
          join public.sp_write_plan_actions a on a.org_id=c.org_id and a.profile_id=c.profile_id and a.plan_id=c.plan_id
          cross join lateral jsonb_array_elements(a.artifact->'sources') item
          where c.org_id=${plan.orgId}::uuid and c.profile_id=${plan.profileId}::uuid and c.direction='forward'
            and c.plan_id<>${plan.id}::uuid and item->>'kind'='apply_row'
            and (item->>'applyRowId')::uuid=any(${ids}::uuid[])
            and not exists(select 1 from ancestors where ancestors.plan_id=c.plan_id and ancestors.source_row_id::text=item->>'applyRowId')) as current`;
      if (!ownership?.current) reasons.add('source_changed');
    }
    // A forward approval binds the frozen grant version. A newly approved inverse
    // uses the current grant, as the existing inverse admission contract specifies.
    if (plan.direction === 'forward' && (row.grant_id !== source.evidence.guardrails.profileGrantId
      || row.grant_version !== source.evidence.guardrails.profileGrantVersion)) reasons.add('grant_changed');

    const placementBaselines = new Map<string, SpCompleteCampaignBiddingState>();
    if (plan.direction === 'forward' && source.evidence.schemaVersion === 'openspell.sp-write-preview-evidence.v3') {
      for (const set of source.evidence.provenance.dependencySets) {
        let snapshot: unknown;
        try { snapshot = JSON.parse(set.calculationSnapshotText); }
        catch { reasons.add('source_changed'); continue; }
        const parsed = CoordinatedMethodInput.safeParse(snapshot);
        const group = plan.dependencySets?.find((candidate) => candidate.dependencySetId === set.dependencySetId);
        if (!parsed.success || parsed.data.profileId !== plan.profileId
          || parsed.data.campaignEvidence.currentControls === null || group === undefined) {
          reasons.add('source_changed'); continue;
        }
        for (const actionId of group.actionIds) {
          const action = plan.actions.find((candidate) => candidate.actionId === actionId);
          if (action?.routeKey !== 'sp.v3.campaigns.update') continue;
          if (action.entity.campaignId !== parsed.data.campaignEvidence.campaignId) {
            reasons.add('source_changed'); continue;
          }
          // Every step is compared with the campaign's initial evidence for freshness.
          // Its immutable action still expects the state left by the preceding step.
          placementBaselines.set(actionId, parsed.data.campaignEvidence.currentControls);
        }
      }
    }

    const keywordIds = plan.actions.flatMap((action) => action.routeKey === 'sp.v3.keywords.update'
      && action.changes.bid !== undefined && Object.keys(action.changes).length === 1 ? [action.entity.keywordId] : []);
    const targetIds = plan.actions.flatMap((action) => action.routeKey === 'sp.v3.targets.update'
      && action.changes.bid !== undefined && Object.keys(action.changes).length === 1 ? [action.entity.targetId] : []);
    const bidEntities = await sql<{ entity_type: 'keyword' | 'target'; amazon_id: string; name: string | null; bid: string | null;
      state: string; synced_at: string | null; available: boolean }[]>`
      select 'keyword' as entity_type, amazon_id, name, bid::text, state::text,
        case when synced_at is null then null else to_char(synced_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end as synced_at,
        (ad_product = 'SP' and deleted_at is null and state in ('enabled', 'paused')) as available
      from public.keywords where org_id = ${plan.orgId}::uuid and profile_id = ${plan.profileId}::uuid
        and amazon_id = any(${keywordIds}::text[])
      union all
      select 'target' as entity_type, amazon_id, name, bid::text, state::text,
        case when synced_at is null then null else to_char(synced_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end as synced_at,
        (ad_product = 'SP' and deleted_at is null and state in ('enabled', 'paused')) as available
      from public.targets where org_id = ${plan.orgId}::uuid and profile_id = ${plan.profileId}::uuid
        and amazon_id = any(${targetIds}::text[])
    `;
    const byBidEntity = new Map(bidEntities.map((entity) => [`${entity.entity_type}:${entity.amazon_id}`, entity]));
    const campaignIds = plan.actions.flatMap((action) => action.routeKey === 'sp.v3.campaigns.update'
      && action.changes.placement !== undefined && Object.keys(action.changes).length === 1 ? [action.entity.campaignId] : []);
    const campaigns = campaignIds.length === 0 ? [] : await sql<{
      amazon_id: string; name: string | null; state: 'enabled' | 'paused' | 'archived'; available: boolean;
      bidding_control_state: unknown; bidding_observed_at: string | null; projection_matches: boolean;
    }[]>`
      select amazon_id, name, state::text,
        (ad_product = 'SP' and deleted_at is null and state in ('enabled', 'paused')) as available,
        bidding_control_state,
        case when bidding_observed_at is null then null else to_char(bidding_observed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end as bidding_observed_at,
        coalesce(bidding_strategy::text = bidding_control_state ->> 'strategy'
          and placement_bidding -> 'topOfSearch' = bidding_control_state #> '{placements,topOfSearch}'
          and placement_bidding -> 'productPages' = bidding_control_state #> '{placements,productPages}'
          and placement_bidding -> 'restOfSearch' = bidding_control_state #> '{placements,restOfSearch}', false) as projection_matches
      from public.campaigns where org_id = ${plan.orgId}::uuid and profile_id = ${plan.profileId}::uuid
        and amazon_id = any(${campaignIds}::text[])
    `;
    const byCampaign = new Map(campaigns.map((campaign) => [campaign.amazon_id, campaign]));
    const currentRows: SpWriteRecordedPreview['currentRows'] = plan.actions.map((action) => {
      if (action.routeKey === 'sp.v3.campaigns.update' && action.changes.placement !== undefined
        && Object.keys(action.changes).length === 1) {
        const campaign = byCampaign.get(action.entity.campaignId);
        const current = SpCompleteCampaignBiddingState.safeParse(campaign?.bidding_control_state);
        if (!campaign?.available || campaign.bidding_observed_at === null || !current.success) {
          reasons.add('entity_unavailable');
          return { actionId: action.actionId, entityName: campaign?.name ?? null,
            syncedAt: campaign?.bidding_observed_at ?? null, observation: null };
        }
        const expected = plan.schemaVersion === 'openspell.sp-write-plan.v3' && plan.direction === 'forward'
          ? placementBaselines.get(action.actionId) : action.changes.placement.expected;
        if (expected === undefined) reasons.add('source_changed');
        else if (JSON.stringify(current.data) !== JSON.stringify(expected)) reasons.add('current_value_changed');
        if (!campaign.projection_matches) reasons.add('current_value_changed');
        return { actionId: action.actionId, entityName: campaign.name, syncedAt: campaign.bidding_observed_at,
          observation: { routeKey: action.routeKey, actionId: action.actionId, actionFingerprint: action.fingerprint,
            amazonEntityId: action.entity.campaignId,
            values: { placement: current.data, state: campaign.state === 'enabled' ? 'enabled' : 'paused' } } };
      }
      if ((action.routeKey !== 'sp.v3.keywords.update' && action.routeKey !== 'sp.v3.targets.update') || action.changes.bid === undefined
        || Object.keys(action.changes).length !== 1) {
        reasons.add('unsupported_action');
        return { actionId: action.actionId, entityName: null, syncedAt: null, observation: null };
      }
      const entityId = action.routeKey === 'sp.v3.keywords.update' ? action.entity.keywordId : action.entity.targetId;
      const entity = byBidEntity.get(`${action.routeKey === 'sp.v3.keywords.update' ? 'keyword' : 'target'}:${entityId}`);
      const amount = canonicalAmount(entity?.bid ?? null);
      if (!entity?.available || entity.synced_at === null || amount === null
        || !['enabled', 'paused'].includes(entity.state)) {
        reasons.add('entity_unavailable');
        return { actionId: action.actionId, entityName: entity?.name ?? null,
          syncedAt: entity?.synced_at ?? null, observation: null };
      }
      if (amount !== action.changes.bid.expected.amount) reasons.add('current_value_changed');
      return { actionId: action.actionId, entityName: entity.name, syncedAt: entity.synced_at,
        observation: { routeKey: action.routeKey, actionId: action.actionId, actionFingerprint: action.fingerprint,
          amazonEntityId: entityId,
          values: { bid: { amount, currencyCode: plan.providerScope.currencyCode },
            state: entity.state === 'enabled' ? 'enabled' : 'paused' } } };
    });
    return SpWriteRecordedPreview.parse({ preview,
      profile: { id: plan.profileId, label: row.label, currencyCode: plan.providerScope.currencyCode },
      currentRows, freshness: { checkedAt: row.checked_at,
        status: reasons.has('entity_unavailable') || reasons.has('unsupported_action') ? 'unavailable'
          : reasons.size > 0 ? 'stale' : 'current', reasons: [...reasons] },
      admission: await priorAdmission(sql, preview),
    });
}
