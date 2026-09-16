import { randomUUID } from 'node:crypto';
import { CampaignCreationBatch, campaignCreationBatchSummary, type CampaignCreationClaim } from '@wizard-ads/shared';
import type { SpCreationBatchAdapter } from '@wizard-ads/ads-api';
import type { createCampaignCreationLedger } from '@wizard-ads/db/worker';
import type { SpWriteWorkerPolicy } from '../sp-write-outbox/policy.js';
import type { SpWriteTickResult } from '../sp-write-outbox/loop.js';

interface Dependencies {
  ledger: ReturnType<typeof createCampaignCreationLedger>;
  claimantId: string;
  policy(): SpWriteWorkerPolicy;
  provider(batch: CampaignCreationBatch, signal: AbortSignal): Promise<SpCreationBatchAdapter>;
  now?: () => number;
}

/** One node per claim. Restarting after reservation never returns permission to POST. */
export function createCampaignCreationWorker(dependencies: Dependencies) {
  let running = false;
  const shutdown = new AbortController();
  const now = dependencies.now ?? Date.now;
  return {
    stop() { shutdown.abort(); },
    async tick(options: { signal?: AbortSignal } = {}): Promise<SpWriteTickResult> {
      if (running) return { kind: 'busy', attemptedCalls: 0 };
      if (shutdown.signal.aborted) return { kind: 'disabled', attemptedCalls: 0 };
      const policy = dependencies.policy();
      if ((!policy.dispatchEnabled && !policy.reconcileEnabled) || policy.profileIds.length === 0) return { kind: 'disabled', attemptedCalls: 0 };
      running = true;
      let claim: CampaignCreationClaim | null = null;
      let attemptedCalls = 0;
      try {
        const signal = AbortSignal.any([shutdown.signal, ...(options.signal ? [options.signal] : [])]);
        signal.throwIfAborted();
        claim = await dependencies.ledger.claim(dependencies.claimantId, policy.profileIds);
        if (!claim) return { kind: 'idle', attemptedCalls };
        let batch = CampaignCreationBatch.parse(await dependencies.ledger.load(claim));
        const permitted = (mode: 'dispatchEnabled' | 'reconcileEnabled') => {
          const latest = dependencies.policy();
          return latest[mode] && latest.profileIds.includes(batch.plan.profileId)
            && (latest.planIds === undefined || latest.planIds.includes(batch.plan.id));
        };
        if (campaignCreationBatchSummary(batch).terminal) return { kind: 'completed', attemptedCalls };
        const node = batch.nodes.find((row) => row.refusal === null && row.result?.outcome !== 'authoritative_rejected'
          && !['observed', 'conflict', 'uncertain', 'ambiguous_readback'].includes(row.observation?.observation ?? ''));
        if (!node) return { kind: 'completed', attemptedCalls };
        if (node.intent !== null) {
          // Expired custody permits a read, never another POST under this reservation.
          if (!permitted('reconcileEnabled') || (node.result?.outcome !== 'succeeded' && now() < Date.parse(node.intent.deadline))
            || (node.observation?.observation === 'not_found' && node.intent.preflightObservationId !== node.observation.id
              && now() < Date.parse(node.observation.observedAt) + 60_000)) {
            return { kind: 'deferred', attemptedCalls };
          }
          const provider = await dependencies.provider(batch, signal);
          if (!permitted('reconcileEnabled')) return { kind: 'deferred', attemptedCalls };
          const observation = await provider.observe(batch, node.nodeId, signal);
          await dependencies.ledger.observe(batch.id, node.nodeId, observation);
          return { kind: observation.observation === 'observed' ? 'completed' : 'deferred', attemptedCalls };
        }
        if (!permitted('dispatchEnabled')) return { kind: 'deferred', attemptedCalls };
        const provider = await dependencies.provider(batch, signal);
        if (batch.lineage !== null) {
          if (!permitted('reconcileEnabled')) return { kind: 'deferred', attemptedCalls };
          const read = await provider.observe(batch, node.nodeId, signal);
          await dependencies.ledger.observe(batch.id, node.nodeId, read);
          batch = CampaignCreationBatch.parse(await dependencies.ledger.load(claim));
          const recorded = batch.nodes.find((row) => row.nodeId === node.nodeId)!.observation;
          if (recorded?.observation !== 'not_found' || !recorded.complete) {
            return { kind: recorded?.observation === 'observed' ? 'completed' : 'deferred', attemptedCalls };
          }
        }
        const call = provider.prepare(batch, node.nodeId);
        if (call.positions.length !== 1 || call.positions[0]?.nodeId !== node.nodeId) throw new Error('Creation request count mismatch');
        signal.throwIfAborted();
        if (!permitted('dispatchEnabled')) return { kind: 'deferred', attemptedCalls };
        const reservation = await dependencies.ledger.reserve(claim, node.nodeId, { id: randomUUID(), requestDigest: call.requestDigest,
          nodeRequestDigest: call.positions[0].requestDigest, reservedAt: new Date(now()).toISOString(), deadline: new Date(now() + 35_000).toISOString() });
        if (reservation.kind !== 'dispatch_once') return { kind: reservation.kind === 'stale' ? 'stale' : 'deferred', attemptedCalls };
        batch = CampaignCreationBatch.parse(await dependencies.ledger.load(claim));
        if (signal.aborted || !permitted('dispatchEnabled')) return { kind: 'deferred', attemptedCalls };
        attemptedCalls = 1;
        const result = await provider.execute(batch, node.nodeId, signal);
        await dependencies.ledger.result(batch.id, node.nodeId, result);
        return { kind: 'completed', attemptedCalls };
      } catch {
        // The durable intent remains the recovery boundary. No raw provider or SQL error escapes.
        return { kind: 'fault', attemptedCalls };
      } finally {
        if (claim) { try { await dependencies.ledger.settle(claim); } catch { /* The claim expires. */ } }
        running = false;
      }
    },
  };
}
