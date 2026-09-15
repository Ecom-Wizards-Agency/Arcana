import { createHash, randomUUID } from 'node:crypto';
import {
  SpWriteObservation, SpWriteObservedAction, SpWritePredispatchObservation, SpWriteProviderCallIntent,
  serializeSpWriteObservationFingerprint, serializeSpWritePredispatchObservationFingerprint,
  serializeSpWriteProviderCallIntentFingerprint, serializeSpWriteProviderRequestFingerprint,
  observedActionForSide,
  type SpWriteAction, type SpWriteExecutionEvidence, type SpWritePlan, type SpWriteProviderResult,
} from '@wizard-ads/shared/sp-writes';
import type { SpWritePreparedCall } from '@wizard-ads/ads-api/sp-write-adapter';
import type { SpWriteDispatchTicket, SpWriteObserveAndRecoverOutboxClaim } from '@wizard-ads/db/sp-write-persistence';

export const hasher = { algorithm: 'sha256' as const, digest: (text: string) => createHash('sha256').update(text).digest('hex') };
const ZERO = '0'.repeat(64);

export function providerKey(plan: SpWritePlan): string {
  return JSON.stringify([plan.orgId, plan.profileId, plan.providerScope]);
}

function identity(evidence: SpWriteExecutionEvidence) {
  return { planId: evidence.plan.id, planFingerprint: evidence.plan.fingerprint,
    approvalId: evidence.authorization.approvalId, executionId: evidence.authorization.executionId,
    generation: evidence.authorization.generation };
}

export function makeReservationArtifacts(
  evidence: SpWriteExecutionEvidence, call: SpWritePreparedCall, leaseId: string,
  items: readonly SpWriteObservedAction[], observedAt: string,
): { observation: SpWritePredispatchObservation; intent: SpWriteProviderCallIntent } {
  const observation = SpWritePredispatchObservation.parse({ ...identity(evidence),
    schemaVersion: 'openspell.sp-write-predispatch-observation.v1', observationId: randomUUID(),
    routeKey: call.routeKey, observedAt, validUntil: new Date(Date.parse(observedAt) + 60_000).toISOString(),
    items, fingerprint: ZERO,
  });
  observation.fingerprint = hasher.digest(serializeSpWritePredispatchObservationFingerprint(observation));
  const intent = SpWriteProviderCallIntent.parse({ ...identity(evidence),
    schemaVersion: 'openspell.sp-write-provider-call-intent.v1', intentId: randomUUID(), providerCallId: randomUUID(),
    routeKey: call.routeKey, attemptNumber: 1, dispatchLeaseId: leaseId,
    providerObservationFingerprint: observation.fingerprint, requestFingerprint: ZERO, recordedAt: observedAt,
    positions: call.positions, fingerprint: ZERO,
  });
  intent.requestFingerprint = hasher.digest(serializeSpWriteProviderRequestFingerprint(intent));
  intent.fingerprint = hasher.digest(serializeSpWriteProviderCallIntentFingerprint(intent));
  return { observation, intent };
}

/** Subtract the entire reservation round trip; never add time from a local wall clock. */
export function remainingAttemptMs(ticket: SpWriteDispatchTicket, elapsedMs: number): number {
  const start = Date.parse(ticket.dispatchStartDeadline) - Date.parse(ticket.databaseReadAt) - elapsedMs;
  const attempt = Date.parse(ticket.providerAttemptDeadline) - Date.parse(ticket.databaseReadAt) - elapsedMs;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || !Number.isFinite(start) || !Number.isFinite(attempt) || start <= 0) return 0;
  return Math.max(0, Math.floor(attempt));
}

type DispatchProgress = {
  plan: { actions: readonly Pick<SpWriteAction, 'actionId'>[]; dependencySets?: SpWritePlan['dependencySets'] };
  predispatchDispositions: readonly Pick<SpWriteExecutionEvidence['predispatchDispositions'][number], 'actionId'>[];
  providerCallIntents: readonly { positions: readonly Pick<SpWriteProviderCallIntent['positions'][number], 'actionId'>[] }[];
};

export function unresolvedActionIds(evidence: DispatchProgress): string[] {
  const resolved = new Set([
    ...evidence.predispatchDispositions.map((row) => row.actionId),
    ...evidence.providerCallIntents.flatMap((intent) => intent.positions.map((row) => row.actionId)),
  ]);
  return evidence.plan.actions.filter((action) => !resolved.has(action.actionId)).map((action) => action.actionId);
}

/** Coordinated execution supports only the controls bound by its immutable plan. */
export function supportedWorkerAction(action: SpWriteAction): boolean {
  if (action.routeKey === 'sp.v3.keywords.update' || action.routeKey === 'sp.v3.targets.update') {
    return action.changes.bid !== undefined && action.changes.state === undefined;
  }
  return action.routeKey === 'sp.v3.campaigns.update' && action.changes.placement !== undefined
    && action.changes.placement.approvedPlacementKeys.length === 1
    && action.changes.budget === undefined && action.changes.state === undefined;
}

/** An intent consumes a step, but only observed success permits its successor. */
export function nextDependencyAction(evidence: DispatchProgress & {
  observations: readonly Pick<SpWriteObservation, 'actionId' | 'outcome'>[];
}): string | null {
  const unresolved = new Set(unresolvedActionIds(evidence));
  for (const group of evidence.plan.dependencySets ?? []) {
    for (const [index, actionId] of group.actionIds.entries()) {
      if (!unresolved.has(actionId)) continue;
      const predecessors = group.actionIds.slice(0, index);
      if (predecessors.every((previous) => evidence.observations.some((observation) =>
        observation.actionId === previous && observation.outcome === 'observed_requested'))) return actionId;
      return null;
    }
  }
  return null;
}

/** A successful complete read is required; failed reads never fabricate a missing entity. */
export function makeObservations(
  evidence: SpWriteExecutionEvidence, claim: SpWriteObserveAndRecoverOutboxClaim,
  intent: SpWriteProviderCallIntent, result: SpWriteProviderResult, items: readonly (SpWriteObservedAction | null)[],
  observedAt: string, settleMs: number,
): { observations: SpWriteObservation[]; pending: number } {
  const observations: SpWriteObservation[] = [];
  if (items.length !== intent.positions.length) throw new Error('SP write observation count mismatch');
  const byAction = new Map<string, SpWriteObservedAction | null>();
  items.forEach((item, index) => {
    const position = intent.positions[index]!;
    const observed = item === null ? null : SpWriteObservedAction.parse(item);
    if (byAction.has(position.actionId) || (observed !== null && (
      observed.actionId !== position.actionId || observed.actionFingerprint !== position.actionFingerprint
      || observed.amazonEntityId !== position.amazonEntityId || observed.routeKey !== intent.routeKey
    ))) throw new Error('SP write observation position mismatch');
    byAction.set(position.actionId, observed);
  });
  const deadline = Date.parse(result.completedAt) + settleMs;
  if (!Number.isFinite(deadline) || !Number.isFinite(Date.parse(observedAt))
    || !Number.isFinite(settleMs) || settleMs < 0) throw new Error('SP write observation window is invalid');
  let pending = 0;
  for (const position of result.positions) {
    if (position.outcome === 'authoritative_rejected'
      || evidence.observations.some((row) => row.intentId === intent.intentId && row.actionId === position.actionId)) continue;
    const action = evidence.plan.actions.find((row) => row.actionId === position.actionId);
    const observed = byAction.get(position.actionId);
    const archived = observed?.values.state === 'archived';
    if (action === undefined || !supportedWorkerAction(action)
      || observed === undefined || (observed !== null && (
        observed.routeKey !== action.routeKey || observed.actionFingerprint !== action.fingerprint
        || observed.amazonEntityId !== observedActionForSide(action, 'expected').amazonEntityId
        || (!archived && Object.keys(observedActionForSide(action, 'expected').values)
          .some((key) => !(key in observed.values)))
        || (observed.values.state !== undefined && !archived)
      ))) {
      throw new Error('SP write observation identity or action unsupported');
    }
    const matches = (side: 'expected' | 'requested') => observed !== null
      && JSON.stringify(observed) === JSON.stringify(observedActionForSide(action, side));
    const requested = !archived && matches('requested');
    if (!requested && !(archived && observed?.routeKey !== 'sp.v3.keywords.update') && Date.parse(observedAt) < deadline) { pending += 1; continue; }
    const observation = SpWriteObservation.parse({ ...identity(evidence),
      schemaVersion: 'openspell.sp-write-observation.v1', observationId: randomUUID(),
      intentId: intent.intentId, intentFingerprint: intent.fingerprint, providerCallId: intent.providerCallId,
      requestFingerprint: intent.requestFingerprint, actionId: action.actionId, actionFingerprint: action.fingerprint,
      routeKey: action.routeKey, sourceSyncJobId: claim.sourceSyncJobId, observedAt,
      outcome: observed === null ? 'missing' : archived ? 'conflict' : requested ? 'observed_requested'
        : position.outcome === 'ambiguous' && matches('expected') ? 'observed_expected_after_ambiguous' : 'conflict',
      observed, fingerprint: ZERO,
    });
    observation.fingerprint = hasher.digest(serializeSpWriteObservationFingerprint(observation));
    observations.push(observation);
  }
  return { observations, pending };
}
