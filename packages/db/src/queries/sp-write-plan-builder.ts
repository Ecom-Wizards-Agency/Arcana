import { createHash } from 'node:crypto';
import { serializeApplyRows, DependencySet, CoordinatedMethodInput, type ApplyRow } from '@wizard-ads/shared';
import { SpWriteActor, SpWritePreview, SpWritePreviewRequest } from '@wizard-ads/shared/sp-write-application';
import {
  SpWritePreviewEvidence, SpWriteDependencyPreviewEvidence, serializeSpWritePreviewGuardrails, serializeSpWritePreviewProvenance,
} from '@wizard-ads/shared/sp-write-preview-evidence';
import {
  SpCanonicalDecimal,
  SpWriteAction,
  SpWritePlan,
  SpWriteProviderScope,
  SpCompleteCampaignBiddingState,
  type SpWriteDependencySet,
  type SpWriteRouteCounts,
  orderSpWriteActions,
  serializeSpWriteActionFingerprint,
  serializeSpWritePlanFingerprint,
  spWritePlanBinding,
  verifySpWritePlanFingerprints,
} from '@wizard-ads/shared/sp-writes';
import type { DbHandle, QuerySql } from '../client.js';
import { loadSpWritePreviewEvidence, recordSpWritePreviewEvidence } from './sp-write-preview-evidence.js';
import { SpWriteApplicationError } from './sp-write-errors.js';
import { toDate } from './pg-time.js';

// Preview freshness is an application protocol limit, not a tenant bid cap.
const PREVIEW_LIFETIME_MS = 15 * 60_000;
const ZERO_HASH = '0'.repeat(64);
const hasher = { algorithm: 'sha256' as const, digest: sha256 };

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Decimal text normalization never passes through binary floating point. */
function decimal(value: string | null): string {
  if (value === null || !/^\d+(?:\.\d+)?$/.test(value)) {
    throw new SpWriteApplicationError('unsupported_source');
  }
  const [integer = '', fraction = ''] = value.split('.');
  const whole = integer.replace(/^0+(?=\d)/, '');
  const tail = fraction.replace(/0+$/, '');
  const parsed = SpCanonicalDecimal.safeParse(tail ? `${whole}.${tail}` : whole);
  if (!parsed.success) throw new SpWriteApplicationError('unsupported_source');
  return parsed.data;
}

function actionId(planId: string, rowId: string): string {
  const bytes = createHash('sha256').update(JSON.stringify(['openspell.sp-write-action-id.v1', planId, rowId])).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const value = bytes.subarray(0, 16).toString('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

async function requireOperator(sql: QuerySql, actor: SpWriteActor): Promise<void> {
  const rows = await sql<{ allowed: boolean }[]>`
    select exists(select 1 from public.org_members
                   where org_id = ${actor.orgId}::uuid and user_id = ${actor.userId}::uuid
                     and role in ('owner', 'admin')) as allowed
  `;
  if (rows.length !== 1 || rows[0]?.allowed !== true) {
    throw new SpWriteApplicationError('authorization_refused');
  }
}

async function existingPreview(
  sql: QuerySql, actor: SpWriteActor, request: SpWritePreviewRequest,
): Promise<SpWritePreview | null> {
  const recorded = await loadSpWritePreviewEvidence(sql, {
    orgId: actor.orgId, profileId: request.profileId, planId: request.requestId,
  });
  if (recorded === null) return null;
  const { plan, evidence } = recorded;
  if (evidence.schemaVersion === 'openspell.sp-write-preview-evidence.v2') {
    throw new SpWriteApplicationError('unsupported_source');
  }
  if (!spWritePreviewRequestMatches(plan, request)) {
    throw new SpWriteApplicationError('identity_conflict');
  }
  return SpWritePreview.parse({ plan, binding: spWritePlanBinding(plan), evidence });
}

/** Replay identity includes the complete normalized scope, not just the source batch. */
export function spWritePreviewRequestMatches(plan: SpWritePlan, request: SpWritePreviewRequest): boolean {
  return plan.profileId === request.profileId && plan.source.kind === 'apply_batch'
    && plan.source.restoreProposal === undefined && plan.source.applyBatchId === request.applyBatchId
    && JSON.stringify(plan.source.forwardRowIds) === JSON.stringify(request.forwardRowIds)
    && JSON.stringify(plan.source.retryOrigin) === JSON.stringify(request.retryOrigin);
}

interface BatchSnapshot {
  tag: string;
  grant_id: string;
  grant_version: string;
  status: string;
  source_batch_id: string | null;
  artifact_sha256: string | null;
  reversible_rows: number;
  unsupported_rows: number;
  exported_proposals: number;
  dependency_sets_count: number | null;
  opt_group: string;
  lever: string;
  note: string;
  exported_at: string;
  amazon_profile_id: string;
  connection_id: string;
  region: string;
  marketplace_id: string;
  currency_code: string;
  api_dialect: string;
}

interface SourceRow {
  id: string;
  entity_type: string;
  entity_id: string;
  entity_name: string | null;
  field: string;
  old_value: string | null;
  new_value: string | null;
  old_json: string;
  new_json: string;
  clicks: string | null;
  revenue: string | null;
  current_bid: string | null;
  ad_product: string | null;
  deleted_at: Date | string | null;
  entity_state: string | null;
  synced_at: Date | string | null;
  read_at: string | null;
  recommendation_id: string | null;
  proposal_revision_id: string | null;
  run_id: string | null;
  strategy_snapshot: string | null;
  strategy_goal: string | null;
  group_id: string | null;
  group_snapshot: string | null;
  method_id: string | null;
  method_version: string | null;
  trace_text: string | null;
  setting_sources_text: string | null;
  dependency_set_id: string | null;
  dependency_step_index: number | null;
  dependency_set_text: string | null;
  calculation_snapshot_text: string | null;
  calculation_snapshot_count: number;
  bidding_strategy: string | null;
  placement_bidding: Record<string, number> | null;
  bidding_control_state: unknown;

}

// Compatibility only: reproduce the existing export serializer, refusing any
// numeric source it cannot round-trip exactly. Plan money never uses this value.
function exportScalar(raw: string): ApplyRow['old'] {
  const value: unknown = JSON.parse(raw);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value) && decimal(String(value)) === decimal(raw)) return value;
  throw new SpWriteApplicationError('unsupported_source');
}

function exportNumber(raw: string): number {
  const value = exportScalar(raw);
  if (typeof value !== 'number') throw new SpWriteApplicationError('unsupported_source');
  return value;
}

/** The frozen calculation binds unchanged controls and bids as well as changed fields. */
async function assertExposureBaseline(sql: QuerySql, orgId: string, profileId: string, snapshot: CoordinatedMethodInput): Promise<void> {
  const controls = snapshot.campaignEvidence.currentControls;
  const bids = Object.fromEntries(snapshot.evidenceRows.map((row) => [`${row.entityRef.entityType}:${row.entityRef.entityId}`, row.currentBid]));
  if (controls === null || !snapshot.campaignEvidence.complete
    || snapshot.campaignEvidence.targetCount !== snapshot.evidenceRows.length
    || Object.keys(bids).length !== snapshot.evidenceRows.length
    || snapshot.evidenceRows.some((row) => row.entityRef.profileId !== profileId
      || row.entityRef.campaignId !== snapshot.campaignEvidence.campaignId || row.currentBid === null || row.currentBid <= 0)) {
    throw new SpWriteApplicationError('source_changed');
  }
  const [source] = await sql<{ matches: boolean }[]>`
    select exists(select 1 from public.campaigns c where c.org_id=${orgId}::uuid and c.profile_id=${profileId}::uuid
      and c.amazon_id=${snapshot.campaignEvidence.campaignId} and c.ad_product='SP'
      and c.state in ('enabled','paused') and c.deleted_at is null and c.synced_at is not null
      and c.bidding_observed_at is not null and c.bidding_control_state=${JSON.stringify(controls)}::jsonb
      and c.bidding_strategy::text=${controls.strategy}
      and c.placement_bidding->'topOfSearch'=${JSON.stringify(controls.placements.topOfSearch)}::jsonb
      and c.placement_bidding->'restOfSearch'=${JSON.stringify(controls.placements.restOfSearch)}::jsonb
      and c.placement_bidding->'productPages'=${JSON.stringify(controls.placements.productPages)}::jsonb)
      and (select coalesce(jsonb_object_agg(kind||':'||amazon_id,to_jsonb(bid)),'{}'::jsonb) from (
        select 'keyword' as kind,amazon_id,case when synced_at is null then null else bid end as bid from public.keywords where org_id=${orgId}::uuid and profile_id=${profileId}::uuid
          and campaign_id=${snapshot.campaignEvidence.campaignId} and ad_product='SP' and state in ('enabled','paused') and deleted_at is null
        union all select 'target',amazon_id,case when synced_at is null then null else bid end from public.targets where org_id=${orgId}::uuid and profile_id=${profileId}::uuid
          and campaign_id=${snapshot.campaignEvidence.campaignId} and ad_product='SP' and state in ('enabled','paused') and deleted_at is null
      ) all_bids)=${JSON.stringify(bids)}::jsonb as matches
  `;
  if (source?.matches !== true) throw new SpWriteApplicationError('source_changed');
}

/** Package-private source builder. Callers own authorization and atomic persistence. */
export async function buildSpWriteLegacyPreview(
  sql: QuerySql, orgId: string, request: SpWritePreviewRequest,
  restoreRowIds?: readonly string[],
): Promise<{ plan: SpWritePlan; evidence: SpWritePreviewEvidence | SpWriteDependencyPreviewEvidence }> {
  if (restoreRowIds !== undefined && request.forwardRowIds !== undefined) throw new SpWriteApplicationError('invalid_request');
  const batches = await sql<BatchSnapshot[]>`
    select b.tag, g.grant_id::text, g.version_id::text as grant_version,
           b.status::text, b.source_batch_id::text, b.artifact_sha256,
           b.reversible_rows, b.unsupported_rows, b.exported_proposals, b.dependency_sets_count,
           b.opt_group, b.lever, b.note,
           to_char(b.exported_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as exported_at,
           p.amazon_profile_id, p.connection_id::text, p.region::text,
           g.marketplace_id, p.currency_code, g.api_dialect
      from public.apply_batches b
      join public.ad_profiles p on p.org_id = b.org_id and p.id = b.profile_id
      join public.ads_connections c on c.org_id = p.org_id and c.id = p.connection_id
      join public.sp_write_profile_grant_heads h on h.org_id = p.org_id and h.profile_id = p.id
      join public.sp_write_profile_grant_versions g
        on g.org_id = h.org_id and g.profile_id = h.profile_id
       and g.grant_id = h.grant_id and g.version_id = h.version_id
     where b.org_id = ${orgId}::uuid and b.profile_id = ${request.profileId}::uuid
       and b.id = ${request.applyBatchId}::uuid
       and b.source_kind = 'legacy_export'
       and p.sync_enabled and c.status = 'active' and g.enabled
       and g.amazon_profile_id = p.amazon_profile_id and g.connection_id = p.connection_id
       and g.region = p.region and g.currency_code = p.currency_code and g.api_dialect = 'sp_v3'
  `;
  if (batches.length !== 1) throw new SpWriteApplicationError('not_found');
  const batch = batches[0]!;
  if ((!restoreRowIds && batch.status !== 'staged') || (restoreRowIds && !['staged','applied'].includes(batch.status)) || batch.source_batch_id !== null
    || batch.artifact_sha256 === null || !/^[a-f0-9]{64}$/.test(batch.artifact_sha256)
    || (!restoreRowIds && (batch.unsupported_rows !== 0 || batch.reversible_rows < 1 || batch.reversible_rows > 500
      || (batch.dependency_sets_count === null && batch.exported_proposals !== batch.reversible_rows)
      || (batch.dependency_sets_count !== null && (batch.dependency_sets_count !== batch.exported_proposals
        || batch.dependency_sets_count < 1 || batch.dependency_sets_count > batch.reversible_rows))))) {
    throw new SpWriteApplicationError('unsupported_source');
  }
  if ((restoreRowIds || request.forwardRowIds) && batch.dependency_sets_count !== null) {
    throw new SpWriteApplicationError('unsupported_source');
  }
  const sourceRows = await sql<SourceRow[]>`
    select r.id::text, r.entity_type::text, r.entity_id, r.entity_name, r.field,
           r.old_value #>> '{}' as old_value, r.new_value #>> '{}' as new_value,
           r.old_value::text as old_json, r.new_value::text as new_json,
           r.clicks::text, r.revenue::text,
           coalesce(k.bid,t.bid)::text as current_bid, coalesce(k.ad_product,t.ad_product,c.ad_product)::text as ad_product,
           coalesce(k.deleted_at,t.deleted_at,c.deleted_at) as deleted_at,
           coalesce(k.state,t.state,c.state)::text as entity_state, coalesce(k.synced_at,t.synced_at,c.synced_at) as synced_at,
           c.bidding_strategy::text, c.placement_bidding, c.bidding_control_state,
           r.dependency_set_id, r.dependency_step_index,
           (rec.inputs -> 'dependencySet')::text as dependency_set_text,
           snapshot.calculation_snapshot_text, snapshot.calculation_snapshot_count,
           to_char(mirror.current_synced_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as read_at,
           r.recommendation_id::text, r.proposal_revision_id::text, rec.run_id::text,
           (case when run.scope_version=2 then run.execution_snapshot else run.strategy_snapshot end)::text as strategy_snapshot,
           case when run.scope_version=2 then 'one_time' else run.strategy_goal end as strategy_goal,
           run.group_id::text, run.group_snapshot::text,
           rec.inputs ->> 'methodId' as method_id, rec.inputs ->> 'methodVersion' as method_version,
           (rec.inputs -> 'trace')::text as trace_text,
           (rec.inputs -> 'settingSources')::text as setting_sources_text
      from public.apply_rows r
      left join public.keywords k
        on r.entity_type = 'keyword' and k.org_id = r.org_id and k.profile_id = r.profile_id and k.amazon_id = r.entity_id
      left join public.targets t
        on r.entity_type = 'target' and t.org_id = r.org_id and t.profile_id = r.profile_id and t.amazon_id = r.entity_id
      left join public.campaigns c
        on r.entity_type = 'campaign' and c.org_id = r.org_id and c.profile_id = r.profile_id and c.amazon_id = r.entity_id
      left join lateral app.resolve_apply_current_value(r.org_id,r.profile_id,r.entity_type,r.entity_id,r.field) mirror on true
      left join public.recommendations rec
        on rec.org_id = r.org_id and rec.profile_id = r.profile_id and rec.id = r.recommendation_id
      left join public.recommendation_runs run
        on run.org_id = rec.org_id and run.profile_id = rec.profile_id and run.id = rec.run_id
      left join lateral (
        select min(item.value::text) as calculation_snapshot_text, count(*)::integer as calculation_snapshot_count
          from public.audit_log audit
          cross join lateral jsonb_array_elements(audit.payload #> '{narrative,calculationSnapshots}') item
         where audit.org_id = rec.org_id
           and audit.action = 'recommendation.run.succeeded' and audit.target_type = 'recommendation_run'
           and audit.target_id = rec.run_id::text and audit.source = 'worker'
           and item.value ->> 'methodId' = 'sp.coordinated-efficiency'
           and item.value #>> '{campaignEvidence,campaignId}' = rec.campaign_id
           and item.value ->> 'runId' = rec.run_id::text and item.value ->> 'profileId' = rec.profile_id::text
      ) snapshot on true
     where r.org_id = ${orgId}::uuid and r.profile_id = ${request.profileId}::uuid
       and r.batch_id = ${request.applyBatchId}::uuid
     order by rec.created_at, rec.id, r.dependency_step_index
  `;
  const sourceArtifactText = serializeApplyRows(sourceRows.map((row): ApplyRow => ({
    entityType: row.entity_type as ApplyRow['entityType'], entityId: row.entity_id, field: row.field,
    old: exportScalar(row.old_json), new: exportScalar(row.new_json),
    ...(row.entity_name === null ? {} : { name: row.entity_name }),
    ...(row.clicks === null ? {} : { clicks: exportNumber(row.clicks) }),
    ...(row.revenue === null ? {} : { revenue: exportNumber(row.revenue) }),
  })));
  if (sha256(sourceArtifactText) !== batch.artifact_sha256) throw new SpWriteApplicationError('source_changed');
  if (request.retryOrigin !== undefined) {
    const origin = request.retryOrigin;
    const [parent] = await sql<{ matches: boolean }[]>`select exists(select 1 from public.sp_write_cycle_plans cycle
      join public.sp_write_plans plan on plan.org_id=cycle.org_id and plan.profile_id=cycle.profile_id and plan.plan_id=cycle.plan_id
      where cycle.org_id=${orgId}::uuid and cycle.profile_id=${request.profileId}::uuid
        and cycle.execution_id=${origin.executionId}::uuid and cycle.plan_id=${origin.planId}::uuid
        and plan.fingerprint=${origin.planFingerprint} and plan.artifact#>>'{source,applyBatchId}'=${request.applyBatchId}) as matches`;
    const population = await sql<{ source_row_id: string }[]>`select source_row_id::text from app.sp_write_retry_population(
      ${orgId}::uuid,${request.profileId}::uuid,${origin.executionId}::uuid,${origin.planId}::uuid) where eligible order by source_row_id`;
    if (!parent?.matches || JSON.stringify(population.map((row) => row.source_row_id)) !== JSON.stringify(request.forwardRowIds)) {
      throw new SpWriteApplicationError('source_changed');
    }
  }
  const narrowedIds = restoreRowIds ?? request.forwardRowIds;
  const rows = narrowedIds ? sourceRows.filter(row => narrowedIds.includes(row.id)) : sourceRows;
  if (rows.length !== (narrowedIds?.length ?? batch.reversible_rows)) throw new SpWriteApplicationError('source_changed');
  const scope = SpWriteProviderScope.parse({
    amazonProfileId: batch.amazon_profile_id, connectionId: batch.connection_id,
    region: batch.region, marketplaceId: batch.marketplace_id,
    currencyCode: batch.currency_code, apiDialect: batch.api_dialect,
  });
  const coordinated = batch.dependency_sets_count !== null;
  const dependencySets: SpWriteDependencySet[] = [];
  const dependencyEvidence: SpWriteDependencyPreviewEvidence['provenance']['dependencySets'] = [];
  const campaignStates = new Map<string, SpCompleteCampaignBiddingState>();
  if (coordinated) {
    const checked = new Set<string>();
    for (const row of rows) {
      if (row.dependency_set_id === null || row.calculation_snapshot_text === null) throw new SpWriteApplicationError('source_changed');
      if (checked.has(row.dependency_set_id)) continue;
      await assertExposureBaseline(sql, orgId, request.profileId, CoordinatedMethodInput.parse(JSON.parse(row.calculation_snapshot_text)));
      checked.add(row.dependency_set_id);
    }
  }
  const actions = rows.map((row) => {
    if (coordinated) {
      if (row.dependency_set_text === null || row.calculation_snapshot_text === null || row.calculation_snapshot_count !== 1
        || row.recommendation_id === null || row.run_id === null || row.strategy_snapshot === null || row.strategy_goal === null
        || row.method_id !== 'sp.coordinated-efficiency' || row.method_version !== 'candidate.1'
        || row.ad_product !== 'SP' || row.deleted_at !== null || row.synced_at === null
        || !['enabled', 'paused'].includes(row.entity_state ?? '') || row.proposal_revision_id !== null) {
        throw new SpWriteApplicationError('unsupported_source');
      }
      const set = DependencySet.parse(JSON.parse(row.dependency_set_text));
      const snapshot = CoordinatedMethodInput.parse(JSON.parse(row.calculation_snapshot_text));
      const stepIndex = row.dependency_step_index;
      const step = stepIndex === null ? undefined : set.changes[stepIndex];
      if (step === undefined || row.dependency_set_id !== set.id || snapshot.runId !== row.run_id
        || snapshot.profileId !== request.profileId || snapshot.campaignEvidence.campaignId !== set.campaignId
        || snapshot.campaignEvidence.currentControls === null || !snapshot.campaignEvidence.complete
        || step.entityRef.entityType !== row.entity_type || step.entityRef.entityId !== row.entity_id
        || step.entityRef.profileId !== request.profileId || decimal(String(step.current)) !== decimal(row.old_value)
        || decimal(String(step.proposed)) !== decimal(row.new_value)) throw new SpWriteApplicationError('source_changed');
      let group = dependencySets.find((candidate) => candidate.dependencySetId === set.id);
      if (group === undefined) {
        if (stepIndex !== 0) throw new SpWriteApplicationError('source_changed');
        group = { dependencySetId: set.id, recommendationId: row.recommendation_id,
          dependencySetSha256: sha256(row.dependency_set_text), actionIds: [], precedenceReasons: set.precedenceReasons };
        dependencySets.push(group);
        dependencyEvidence.push({ dependencySetId: set.id, recommendationId: row.recommendation_id,
          dependencySetText: row.dependency_set_text, dependencySetSha256: group.dependencySetSha256,
          calculationSnapshotText: row.calculation_snapshot_text, calculationSnapshotSha256: sha256(row.calculation_snapshot_text) });
        campaignStates.set(set.id, snapshot.campaignEvidence.currentControls);
      }
      if (group.actionIds.length !== stepIndex) throw new SpWriteApplicationError('source_changed');
      const id = actionId(request.requestId, row.id);
      group.actionIds.push(id);
      let draft: unknown;
      if (step.control === 'target_bid' && row.field === 'bid'
        && (row.entity_type === 'keyword' || row.entity_type === 'target')) {
        if (decimal(row.current_bid) !== decimal(row.old_value)) throw new SpWriteApplicationError('source_changed');
        draft = { actionId: id, routeKey: `sp.v3.${row.entity_type === 'keyword' ? 'keywords' : 'targets'}.update`,
          entity: row.entity_type === 'keyword' ? { keywordId: row.entity_id } : { targetId: row.entity_id },
          sources: [{ kind: 'apply_row', applyRowId: row.id, changeKey: `${row.entity_type}.bid` }],
          changes: { bid: { expected: { amount: decimal(row.old_value), currencyCode: scope.currencyCode },
            requested: { amount: decimal(row.new_value), currencyCode: scope.currencyCode } } }, fingerprint: ZERO_HASH };
      } else if (step.control === 'placement_adjustment' && step.placementKey !== 'amazon_business') {
        const key = { top_of_search: 'topOfSearch', rest_of_search: 'restOfSearch', product_pages: 'productPages' }[step.placementKey];
        const field = { top_of_search: 'tos_modifier', rest_of_search: 'ros_modifier', product_pages: 'pp_modifier' }[step.placementKey];
        const baseline = snapshot.campaignEvidence.currentControls;
        const expected = campaignStates.get(set.id)!;
        if (row.field !== field || row.bidding_strategy !== baseline.strategy || row.placement_bidding === null
          || ['topOfSearch', 'restOfSearch', 'productPages'].some((key) =>
            row.placement_bidding![key] !== baseline.placements[key as keyof typeof baseline.placements])
          || (row.bidding_control_state !== null && JSON.stringify(SpCompleteCampaignBiddingState.parse(row.bidding_control_state)) !== JSON.stringify(baseline))
          || expected.placements[key as keyof typeof expected.placements] !== step.current) throw new SpWriteApplicationError('source_changed');
        const requested = SpCompleteCampaignBiddingState.parse({ ...expected, placements: { ...expected.placements, [key]: step.proposed } });
        campaignStates.set(set.id, requested);
        draft = { actionId: id, routeKey: 'sp.v3.campaigns.update', entity: { campaignId: row.entity_id },
          sources: [{ kind: 'apply_row', applyRowId: row.id, changeKey: `campaign.placement.${step.placementKey}` }],
          changes: { placement: { expected, requested, approvedPlacementKeys: [step.placementKey] } }, fingerprint: ZERO_HASH };
      } else throw new SpWriteApplicationError('unsupported_source');
      const action = SpWriteAction.parse(draft);
      return SpWriteAction.parse({ ...action, fingerprint: sha256(serializeSpWriteActionFingerprint(action)) });
    }
    if (row.dependency_set_id !== null || row.dependency_step_index !== null || row.dependency_set_text !== null) {
      throw new SpWriteApplicationError('unsupported_source');
    }
    if (row.entity_type !== 'keyword' || row.field !== 'bid' || row.ad_product !== 'SP'
      || row.deleted_at !== null || row.synced_at === null
      || !['enabled', 'paused'].includes(row.entity_state ?? '')
      || row.recommendation_id === null || row.run_id === null
      || row.strategy_snapshot === null || row.strategy_goal === null) {
      throw new SpWriteApplicationError('unsupported_source');
    }
    const expected = decimal(restoreRowIds ? row.new_value : row.old_value);
    const requested = decimal(restoreRowIds ? row.old_value : row.new_value);
    if (expected !== decimal(row.current_bid)) throw new SpWriteApplicationError('source_changed');
    if (requested === expected || requested === '0') throw new SpWriteApplicationError('unsupported_source');
    const action = SpWriteAction.parse({
      actionId: actionId(request.requestId, row.id), routeKey: 'sp.v3.keywords.update',
      entity: { keywordId: row.entity_id }, sources: [{ kind: 'apply_row', applyRowId: row.id, changeKey: 'keyword.bid' }],
      changes: { bid: {
        expected: { amount: expected, currencyCode: scope.currencyCode },
        requested: { amount: requested, currencyCode: scope.currencyCode },
      } }, fingerprint: ZERO_HASH,
    });
    return SpWriteAction.parse({ ...action, fingerprint: sha256(serializeSpWriteActionFingerprint(action)) });
  });
  const artifactText = serializeApplyRows(rows.map((row): ApplyRow => ({
    entityType: row.entity_type as ApplyRow['entityType'], entityId: row.entity_id, field: row.field,
    old: exportScalar(row.old_json), new: exportScalar(row.new_json),
    ...(row.entity_name === null ? {} : { name: row.entity_name }),
    ...(row.clicks === null ? {} : { clicks: exportNumber(row.clicks) }),
    ...(row.revenue === null ? {} : { revenue: exportNumber(row.revenue) }),
  })));
  const rawEvidence = {
    schemaVersion: coordinated ? 'openspell.sp-write-preview-evidence.v3' : 'openspell.sp-write-preview-evidence.v1', planId: request.requestId,
    guardrails: {
      profileGrantId: batch.grant_id, profileGrantVersion: batch.grant_version,
      providerScope: scope, maximumProviderRows: 500, requireCurrentValueMatch: true,
      policies: rows.map((row) => ({
        applyRowId: row.id, recommendationId: row.recommendation_id, runId: row.run_id,
        strategySnapshotText: row.strategy_snapshot, strategyGoal: row.strategy_goal,
        groupId: row.group_id, groupSnapshotText: row.group_snapshot,
      })),
    },
    provenance: {
      applyBatchId: request.applyBatchId, artifactText, artifactSha256: sha256(artifactText),
      exportedAt: batch.exported_at, tag: batch.tag,
      optGroup: batch.opt_group, lever: batch.lever, note: batch.note,
      ...(coordinated ? { dependencySets: dependencyEvidence } : {}),
      rows: rows.map((row) => ({ ...(coordinated ? { dependencySetId: row.dependency_set_id, dependencyStepIndex: row.dependency_step_index } : {}), applyRowId: row.id, recommendationId: row.recommendation_id, runId: row.run_id,
        ...(row.proposal_revision_id === null ? {} : { proposalRevisionId: row.proposal_revision_id }),
        ...(row.method_id == null && row.method_version == null && row.trace_text == null && row.setting_sources_text == null
          ? {} : { method: { methodId: row.method_id, methodVersion: row.method_version,
            traceSha256: row.trace_text === null ? null : sha256(row.trace_text),
            settingSourcesSha256: row.setting_sources_text === null ? null : sha256(row.setting_sources_text) } }),
      })),
    },
  };
  const evidence = coordinated ? SpWriteDependencyPreviewEvidence.parse(rawEvidence) : SpWritePreviewEvidence.parse(rawEvidence);
  if (coordinated && dependencySets.length !== batch.dependency_sets_count) throw new SpWriteApplicationError('source_changed');
  const byRoute: SpWriteRouteCounts = { 'sp.v3.campaigns.update': 0, 'sp.v3.ad_groups.update': 0,
    'sp.v3.keywords.update': 0, 'sp.v3.targets.update': 0, 'sp.v3.product_ads.update': 0 };
  actions.forEach((action) => { byRoute[action.routeKey] += 1; });
  const nowRows = await sql<{ now: Date | string }[]>`select clock_timestamp() as now`;
  if (nowRows.length !== 1) throw new SpWriteApplicationError('outcome_unknown');
  const now = toDate(nowRows[0]!.now);
  const plan = SpWritePlan.parse({
    schemaVersion: coordinated ? 'openspell.sp-write-plan.v3' : 'openspell.sp-write-plan.v1', id: request.requestId,
    orgId: orgId, profileId: request.profileId, providerScope: scope, direction: 'forward',
    source: {
      kind: 'apply_batch', applyBatchId: request.applyBatchId,
      ...(request.forwardRowIds === undefined ? {} : { forwardRowIds: request.forwardRowIds, sourceArtifactText,
        ...(request.retryOrigin === undefined ? {} : { retryOrigin: request.retryOrigin }) }),
      ...(restoreRowIds ? { restoreProposal: {kind:'restore_proposal',sourceArtifactText,sourceBatchId:request.applyBatchId,
        sourceRowIds:rows.map(row=>row.id),rows:rows.map(row=>({sourceRowId:row.id,entityId:row.entity_id,
          current:{amount:decimal(row.current_bid),currencyCode:scope.currencyCode},readAt:row.read_at,
          restoreTo:{amount:decimal(row.old_value),currencyCode:scope.currencyCode}}))} } : {}),
      guardrailSnapshotFingerprint: sha256(serializeSpWritePreviewGuardrails(evidence)),
      provenanceSnapshotFingerprint: sha256(serializeSpWritePreviewProvenance(evidence)),
    },
    generatedAt: now.toISOString(), frozenAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PREVIEW_LIFETIME_MS).toISOString(),
    actions: coordinated ? actions : orderSpWriteActions(actions),
    ...(coordinated ? { dependencySets } : {}),
    counts: {
      logicalChanges: rows.length, providerRows: rows.length,
      uniqueEntities: new Set(actions.map((action) => JSON.stringify([action.routeKey, action.entity]))).size, byRoute,
    }, fingerprint: ZERO_HASH,
  });
  return { plan: verifySpWritePlanFingerprints({ ...plan, fingerprint: sha256(serializeSpWritePlanFingerprint(plan)) }, hasher), evidence };
}

/** Create or recover the immutable preview; no approval, enqueue or provider I/O. */
export async function previewSpWrite(
  handle: Pick<DbHandle, 'sql'>, rawActor: SpWriteActor, rawRequest: SpWritePreviewRequest,
): Promise<SpWritePreview> {
  const actor = SpWriteActor.parse(rawActor);
  const request = SpWritePreviewRequest.parse(rawRequest);
  const snapshot = await handle.sql.begin('isolation level repeatable read read only', async (sql) => {
    await requireOperator(sql, actor);
    const existing = await existingPreview(sql, actor, request);
    if (existing !== null) return { existing: true, preview: existing };
    const { plan, evidence } = await buildSpWriteLegacyPreview(sql, actor.orgId, request);
    return { existing: false, preview: SpWritePreview.parse({ plan, binding: spWritePlanBinding(plan), evidence }) };
  });
  if (snapshot.existing) return snapshot.preview;
  try {
    if (snapshot.preview.evidence === null || snapshot.preview.evidence.schemaVersion === 'openspell.sp-write-preview-evidence.v2') {
      throw new SpWriteApplicationError('invalid_request');
    }
    await recordSpWritePreviewEvidence(handle, snapshot.preview.plan, snapshot.preview.evidence);
    return snapshot.preview;
  } catch (error) {
    // Collision or a lost insert response may already have committed this preview.
    // Recovery only reads the exact tenant/source identity; it never inserts a new plan.
    if (!(error instanceof SpWriteApplicationError)) throw error;
    await requireOperator(handle.sql, actor);
    const existing = await existingPreview(handle.sql, actor, request);
    if (existing !== null) return existing;
    throw error;
  }
}
