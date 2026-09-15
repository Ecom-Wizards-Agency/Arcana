/** Complete saved optimizer reads. The caller owns the authenticated read snapshot. */
import { Uuid, OptimizerReviewIdentity, OptimizerRunNarrative, OneTimeRpcSnapshot, RecommendationPreviewDiagnostics, MethodAdmissionSnapshot,
  type Hold, type MethodEvaluatorInput, type OptimizerTargetOutcome } from '@wizard-ads/shared';
import { OptimizerOperation, OptimizerOperationRow, SpWriteOperationRequest, spWriteRetryEvidenceAllows, type SpWriteRecordedPreview } from '@wizard-ads/shared/sp-write-application';
import type { SpWriteAction, SpWriteExecutionEvidence, SpWriteObservation } from '@wizard-ads/shared/sp-writes';
import type { QueryHandle } from '../client.js';
import type { AuthenticatedReadSnapshot } from './authenticated-actor.js';
import { getRecommendationRun, listRecommendationWindow } from './recommendations.js';
import { readRecordedSpWritePreviewForActor, readSpWriteOperationForActor } from './sp-write-commands.js';
import { loadExecutionSnapshot } from './sp-write-persistence.js';
import { SpWriteApplicationError } from './sp-write-errors.js';

export class OptimizerRunIntegrityError extends Error {
  constructor() { super('The saved optimizer population does not reconcile.'); this.name = 'OptimizerRunIntegrityError'; }
}

/** Every staged row must belong to this saved optimizer batch, including across child runs. */
export async function assertOptimizerApplyBatch(handle: QueryHandle, input: OptimizerReviewIdentity & { applyBatchId: string }): Promise<void> {
  const scope = OptimizerReviewIdentity.parse({ orgId: input.orgId, profileId: input.profileId, batchId: input.batchId });
  const applyBatchId = Uuid.parse(input.applyBatchId);
  const [counts] = await handle.sql<{ total: number; owned: number }[]>`
    select count(*)::int as total, count(*) filter (where run.batch_id=${scope.batchId}::uuid
      and recommendation.export_batch_id=${applyBatchId}::uuid)::int as owned
    from public.apply_rows source
    left join public.recommendations recommendation on recommendation.org_id=source.org_id
      and recommendation.profile_id=source.profile_id and recommendation.id=source.recommendation_id
    left join public.recommendation_runs run on run.org_id=recommendation.org_id
      and run.profile_id=recommendation.profile_id and run.id=recommendation.run_id
    where source.org_id=${scope.orgId}::uuid and source.profile_id=${scope.profileId}::uuid
      and source.batch_id=${applyBatchId}::uuid`;
  if (!counts || counts.total === 0 || counts.total !== counts.owned) throw new SpWriteApplicationError('not_found');
}

/** Recover saved plans after an interrupted response; this read never prepares or admits work. */
export async function readOptimizerSavedPreviews(context: AuthenticatedReadSnapshot, input: OptimizerReviewIdentity): Promise<SpWriteRecordedPreview[]> {
  const scope = OptimizerReviewIdentity.parse(input);
  if (scope.orgId !== context.actor.orgId) throw new SpWriteApplicationError('not_found');
  const candidates = await context.sql<{ plan_id: string; apply_batch_id: string }[]>`
    select plan.plan_id::text, plan.artifact #>> '{source,applyBatchId}' as apply_batch_id
    from public.sp_write_plans plan
    where plan.org_id=${scope.orgId}::uuid and plan.profile_id=${scope.profileId}::uuid
      and plan.direction='forward' and plan.artifact #>> '{source,kind}'='apply_batch'
      and exists(select 1 from public.recommendations recommendation
        join public.recommendation_runs run on run.org_id=recommendation.org_id
          and run.profile_id=recommendation.profile_id and run.id=recommendation.run_id
        where recommendation.org_id=plan.org_id and recommendation.profile_id=plan.profile_id
          and run.batch_id=${scope.batchId}::uuid
          and recommendation.export_batch_id::text=plan.artifact #>> '{source,applyBatchId}')
    order by plan.generated_at desc,plan.plan_id limit 501`;
  if (candidates.length > 500 || new Set(candidates.map((row) => row.plan_id)).size !== candidates.length) {
    throw new OptimizerRunIntegrityError();
  }
  const saved: SpWriteRecordedPreview[] = [];
  for (const candidate of candidates) {
    await assertOptimizerApplyBatch(context, { ...scope, applyBatchId: candidate.apply_batch_id });
    const recorded = await readRecordedSpWritePreviewForActor(context, { profileId: scope.profileId, planId: candidate.plan_id });
    if (recorded.preview.plan.source.kind !== 'apply_batch'
      || recorded.preview.plan.source.applyBatchId !== candidate.apply_batch_id) throw new OptimizerRunIntegrityError();
    saved.push(recorded);
  }
  return saved;
}

/** Missing historical evidence stays missing; examples are explicitly bounded. */
export function optimizerRunNarrative(raw: unknown) {
  if (raw === null || raw === undefined) return {
    diagnostics: null, holds: [] as Hold[], examples: [] as Array<{ entity: string; outcome: string; detail: string }>,
    calculationSnapshots: [] as MethodEvaluatorInput[], evidenceAvailable: false, holdsComplete: false,
    targetOutcomes: [] as OptimizerTargetOutcome[], unchanged: [] as OptimizerTargetOutcome[],
    blocked: [] as OptimizerTargetOutcome[], outcomesComplete: false,
  };
  const parsed = OptimizerRunNarrative.safeParse(raw);
  if (!parsed.success) throw new OptimizerRunIntegrityError();
  const narrative = parsed.data;
  const targetOutcomes = narrative.targetOutcomes ?? [];
  if (narrative.targetOutcomes !== undefined && (narrative.diagnostics === undefined
    || targetOutcomes.length !== narrative.diagnostics.targetsRead
    || new Set(targetOutcomes.map((row) => JSON.stringify([row.entityRef.profileId, row.entityRef.entityType, row.entityRef.entityId]))).size !== targetOutcomes.length)) {
    throw new OptimizerRunIntegrityError();
  }
  return {
    diagnostics: narrative.diagnostics === undefined ? null : RecommendationPreviewDiagnostics.parse(narrative.diagnostics),
    holds: narrative.holds ?? [], examples: narrative.diagnostics?.examples ?? [],
    calculationSnapshots: narrative.calculationSnapshots ?? [], evidenceAvailable: narrative.diagnostics !== undefined,
    holdsComplete: narrative.holds !== undefined,
    targetOutcomes, unchanged: targetOutcomes.filter((row) => row.outcome === 'unchanged'),
    blocked: targetOutcomes.filter((row) => row.outcome === 'blocked'), outcomesComplete: narrative.targetOutcomes !== undefined,
  };
}

/** Read the exact child roster, campaigns, proposals and retained evaluation evidence. */
export async function readOptimizerReview(handle: QueryHandle, input: OptimizerReviewIdentity) {
  const scope = OptimizerReviewIdentity.parse(input);
  const batches = await handle.sql<{
    id: string; scope_count: number; child_count: number; execution_snapshot: unknown;
  }[]>`select id::text, scope_count, child_count, execution_snapshot from public.recommendation_preview_batches
    where org_id=${scope.orgId}::uuid and profile_id=${scope.profileId}::uuid and id=${scope.batchId}::uuid`;
  if (batches.length === 0) return null;
  if (batches.length !== 1) throw new OptimizerRunIntegrityError();
  const batch = batches[0]!;
  const roster = await handle.sql<{
    run_id: string; scope_count: number; campaign_ids: string[]; narrative: unknown; method_admission: unknown;
  }[]>`select run.id::text as run_id, run.scope_count,
    run.schedule_context->'methodAdmission' as method_admission,
    array(select member.campaign_id from public.recommendation_run_campaigns member
      where member.org_id=run.org_id and member.profile_id=run.profile_id and member.run_id=run.id
      order by member.campaign_id) as campaign_ids,
    (select event.payload->'narrative' from public.audit_log event
      where event.org_id=run.org_id and event.target_type='recommendation_run' and event.target_id=run.id::text
        and event.action='recommendation.run.succeeded' and event.source='worker'
      order by event.created_at desc,event.id desc limit 1) as narrative
    from public.recommendation_runs run
    where run.org_id=${scope.orgId}::uuid and run.profile_id=${scope.profileId}::uuid and run.batch_id=${scope.batchId}::uuid
    order by run.group_id nulls last,run.id`;
  if (roster.length !== batch.child_count || roster.length === 0
    || new Set(roster.map((row) => row.run_id)).size !== roster.length
    || roster.some((row) => row.campaign_ids.length !== row.scope_count)
    || roster.reduce((sum, row) => sum + row.scope_count, 0) !== batch.scope_count
    || new Set(roster.flatMap((row) => row.campaign_ids)).size !== batch.scope_count) {
    throw new OptimizerRunIntegrityError();
  }
  const children = [];
  for (const row of roster) {
    const run = await getRecommendationRun(handle, { orgId: scope.orgId, runId: row.run_id });
    if (run === null || run.profileId !== scope.profileId) throw new OptimizerRunIntegrityError();
    const window = await listRecommendationWindow(handle, { orgId: scope.orgId, profileId: scope.profileId, runId: row.run_id });
    if (window.population.truncated || window.rows.length !== run.proposalsCount
      || window.rows.some((proposal) => proposal.runId !== run.id || proposal.profileId !== scope.profileId)) {
      throw new OptimizerRunIntegrityError();
    }
    const evidence = optimizerRunNarrative(row.narrative);
    const methodAdmission = row.method_admission == null ? null : MethodAdmissionSnapshot.parse(row.method_admission);
    if (methodAdmission !== null && Object.keys(methodAdmission.campaignMethods ?? {}).some((campaignId) => !row.campaign_ids.includes(campaignId))) {
      throw new OptimizerRunIntegrityError();
    }
    if (evidence.diagnostics !== null && evidence.diagnostics.proposed !== run.proposalsCount) throw new OptimizerRunIntegrityError();
    if (evidence.holds.some((hold) => hold.affectedScope.some((entity) => entity.profileId !== scope.profileId
      || (entity.campaignId !== undefined && !row.campaign_ids.includes(entity.campaignId))))) throw new OptimizerRunIntegrityError();
    if (evidence.targetOutcomes.some((outcome) => outcome.entityRef.profileId !== scope.profileId
      || !row.campaign_ids.includes(outcome.entityRef.campaignId ?? ''))) throw new OptimizerRunIntegrityError();
    children.push({ run, campaignIds: row.campaign_ids, methodAdmission, proposals: window.rows, ...evidence });
  }
  const proposals = children.flatMap((child) => child.proposals);
  if (new Set(proposals.map((proposal) => proposal.id)).size !== proposals.length) throw new OptimizerRunIntegrityError();
  const complete = children.every((child) => child.evidenceAvailable);
  const outcomesComplete = children.every((child) => child.outcomesComplete);
  const targetOutcomes = children.flatMap((child) => child.targetOutcomes);
  const evaluated = complete ? children.reduce((sum, child) => sum + child.diagnostics!.targetsRead, 0) : null;
  const status = children.some((child) => child.run.status === 'failed') ? 'failed'
    : children.every((child) => child.run.status === 'succeeded') ? 'succeeded'
    : children.some((child) => child.run.status === 'running') ? 'running' : 'queued';
  return {
    batchId: batch.id, profileId: scope.profileId, campaignCount: batch.scope_count, status,
    executionSnapshot: batch.execution_snapshot == null ? null : OneTimeRpcSnapshot.parse(batch.execution_snapshot),
    children, proposals,
    // Only exact saved evaluator outcomes support the target partition.
    totals: { proposals: proposals.length, evaluated,
      suggestions: outcomesComplete ? targetOutcomes.filter((row) => row.outcome === 'suggestion').length : null,
      blocked: outcomesComplete ? targetOutcomes.filter((row) => row.outcome === 'blocked').length : null,
      unchanged: outcomesComplete ? targetOutcomes.filter((row) => row.outcome === 'unchanged').length : null,
      retainedHolds: children.every((child) => child.holdsComplete)
        ? children.reduce((sum, child) => sum + child.holds.length, 0) : null },
    integrity: { expectedChildren: batch.child_count, loadedChildren: children.length,
      expectedCampaigns: batch.scope_count, loadedCampaigns: roster.flatMap((row) => row.campaign_ids).length,
      loadedProposals: proposals.length, completeEvidence: complete },
  };
}

function moneyOrValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && 'amount' in value && typeof value.amount === 'string') return value.amount;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function actionValue(action: SpWriteAction, side: 'expected' | 'requested'): string | null {
  const changes = Object.values(action.changes);
  return changes.length === 1 ? moneyOrValue(changes[0]?.[side]) : JSON.stringify(action.changes);
}

function observedValue(action: SpWriteAction, observation: SpWriteObservation | null): string | null {
  if (observation?.observed == null) return null;
  const values: Record<string, unknown> = observation.observed.values;
  const fields = Object.keys(action.changes);
  return fields.length === 1 ? moneyOrValue(values[fields[0]!]) : JSON.stringify(values);
}

/** Pure projection of already verified ledger artifacts; unknown outcomes remain unresolved. */
export function optimizerOperationRows(evidence: Pick<SpWriteExecutionEvidence,
  'plan' | 'providerCallIntents' | 'providerResults' | 'observations' | 'predispatchDispositions'>,
names: ReadonlyMap<string, string> = new Map()): OptimizerOperationRow[] {
  const intents = new Map(evidence.providerCallIntents.flatMap((intent) => intent.positions.map((position) => [position.actionId, intent] as const)));
  const results = new Map(evidence.providerResults.flatMap((result) => result.positions.map((position) => [position.actionId, position] as const)));
  const observations = new Map(evidence.observations.map((observation) => [observation.actionId, observation]));
  const refusals = new Map(evidence.predispatchDispositions.map((refusal) => [refusal.actionId, refusal]));
  const settledPopulation = evidence.plan.actions.every((action) => results.has(action.actionId) || refusals.has(action.actionId));
  return evidence.plan.actions.map((action) => {
    const intent = intents.get(action.actionId);
    const result = results.get(action.actionId);
    const observation = observations.get(action.actionId) ?? null;
    const refusal = refusals.get(action.actionId) ?? null;
    const providerOutcome = result?.outcome ?? (intent === undefined ? null : 'ambiguous');
    const successful = result?.outcome === 'accepted' || observation?.outcome === 'observed_requested';
    const retryEligible = settledPopulation && evidence.plan.direction === 'forward' && evidence.plan.dependencySets === undefined && !successful
      && spWriteRetryEvidenceAllows({ refusal, providerOutcome, observation });
    const status = observation?.outcome === 'observed_requested' ? 'observed'
      : observation?.outcome === 'conflict' || observation?.outcome === 'missing' ? 'conflict' : refusal !== null ? 'refused'
      : result?.outcome === 'accepted' ? 'accepted' : result?.outcome === 'authoritative_rejected' ? 'failed'
      : observation?.outcome === 'observed_expected_after_ambiguous' ? 'ambiguous'
      : result?.outcome === 'ambiguous' ? 'ambiguous' : intent === undefined ? 'pending' : 'sending';
    return OptimizerOperationRow.parse({ actionId: action.actionId, action,
      name: names.get(action.actionId) ?? Object.values(action.entity)[0] ?? action.actionId,
      applyRowIds: action.sources.flatMap((source) => source.kind === 'apply_row' ? [source.applyRowId] : []),
      before: actionValue(action, 'expected'), requested: actionValue(action, 'requested'), observed: observedValue(action, observation),
      status, providerOutcome, observation, refusal, reason: refusal?.reason ?? result?.message ?? result?.code
        ?? (observation?.outcome === 'missing' ? 'The entity was missing from the completed sync.'
          : observation?.outcome === 'conflict' ? 'The synchronized value differs from the requested value.' : null),
      retryEligible, retryReason: successful ? 'The earlier successful change will not be sent again.'
        : evidence.plan.dependencySets !== undefined ? 'Dependent controls require a fresh review of the complete set.'
        : !settledPopulation ? 'Wait for the remaining sends and provider responses before refreshing this retry.'
        : retryEligible ? 'A fresh preview and confirmation are required.' : 'Wait for a conclusive provider response or observation.',
    });
  });
}

/** Reuse the guarded operation reader before exposing its complete verified action evidence. */
export async function readOptimizerOperation(context: AuthenticatedReadSnapshot, raw: SpWriteOperationRequest): Promise<OptimizerOperation> {
  const request = SpWriteOperationRequest.parse(raw);
  const detail = await readSpWriteOperationForActor(context, request);
  const evidence = await loadExecutionSnapshot(context.sql, { ...request, orgId: context.actor.orgId,
    approvalId: detail.receipt.approvalId, generation: detail.receipt.generation });
  if (evidence === null || JSON.stringify(evidence.snapshot) !== JSON.stringify(detail.snapshot)) throw new SpWriteApplicationError('source_changed');
  const sources = await context.sql<{ action_id: string; entity_name: string | null }[]>`
    select action.action_id::text, min(source.entity_name) as entity_name
    from public.sp_write_plan_actions action
    cross join lateral jsonb_array_elements(action.artifact->'sources') item
    left join public.apply_rows source on item->>'kind'='apply_row'
      and source.org_id=action.org_id and source.profile_id=action.profile_id and source.id::text=item->>'applyRowId'
    where action.org_id=${context.actor.orgId}::uuid and action.profile_id=${request.profileId}::uuid and action.plan_id=${request.planId}::uuid
    group by action.action_id`;
  if (sources.length !== evidence.plan.actions.length
    || sources.some((source) => !evidence.plan.actions.some((action) => action.actionId === source.action_id))) {
    throw new SpWriteApplicationError('source_changed');
  }
  const names = new Map(sources.flatMap((source) => source.entity_name === null ? [] : [[source.action_id, source.entity_name] as const]));
  return OptimizerOperation.parse({ detail, plan: evidence.plan, rows: optimizerOperationRows(evidence, names) });
}
