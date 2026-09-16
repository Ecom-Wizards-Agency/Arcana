import { describe, expect, it, vi } from 'vitest';
import { CampaignCreationBatch, CampaignCreationProviderResult, campaignCreationBatchSummary, campaignCreationRetrySelection,
  type CampaignCreationClaim, type CampaignCreationBatchIntent } from '@wizard-ads/shared';
import { creationBatch, hasher, id, CAMPAIGN, GROUP, AD, TARGET } from './fixtures.js';
import { createCampaignCreationWorker } from './loop.js';

function setup(initial = creationBatch()) {
  let batch = initial;
  let gate = true;
  let failKeyword = false;
  let uncertainGroup = false;
  let crashAfterReserve = false;
  let observationPending = false;
  let discovery: 'found' | 'absent' | 'ambiguous' = 'found';
  const preflightFound = new Set<string>();
  const calls: string[] = [];
  const reads: string[] = [];
  const claim = { batchId: batch.id, leaseId: id(295) };
  let clock = Date.parse(batch.admittedAt) + 1000;
  const now = () => clock;
  const policy = { dispatchEnabled: true, reconcileEnabled: true, profileIds: [batch.plan.profileId] };
  const ledger = {
    claim: vi.fn(async () => claim), load: async () => CampaignCreationBatch.parse(batch),
    reserve: async (_claim: CampaignCreationClaim, nodeId: string, intent: CampaignCreationBatchIntent) => {
      const node = batch.nodes.find((row) => row.nodeId === nodeId)!;
      if (!gate) { node.refusal = 'gate_closed'; return { kind: 'refused' as const }; }
      if (node.intent) return { kind: 'already_reserved' as const };
      if (batch.lineage) {
        if (node.observation?.observation !== 'not_found' || !node.observation.complete) return { kind: 'pending' as const };
        intent = { ...intent, preflightObservationId: node.observation.id };
      }
      node.intent = intent;
      if (crashAfterReserve) throw new Error('Synthetic crash after durable reservation');
      return { kind: 'dispatch_once' as const, intent };
    },
    result: async (_batchId: string, nodeId: string, result: CampaignCreationProviderResult) => { batch.nodes.find((row) => row.nodeId === nodeId)!.result = result; },
    observe: async (_batchId: string, nodeId: string, observation: NonNullable<CampaignCreationBatch['nodes'][number]['observation']>) => {
      const row = batch.nodes.find((row) => row.nodeId === nodeId)!;
      if (row.intent && observation.observation === 'not_found' && row.observations.some((read) => read.observation === 'not_found'
        && Date.parse(read.observedAt) <= now() - 60_000)) observation = { ...observation, observation: 'uncertain', reason: 'No resource matched in two complete observations at least 60 seconds apart.' };
      row.observation = observation; row.observations.push(observation);
    },
    settle: vi.fn(async () => {
      if (batch.nodes.some((row) => ['uncertain','ambiguous_readback','conflict'].includes(row.observation?.observation ?? ''))) {
        for (const row of batch.nodes) if (!row.intent && row.observation?.observation !== 'observed') row.refusal = 'dependency_failed';
      }
    }),
  };
  const provider = {
    prepare: (current: CampaignCreationBatch, nodeId: string) => ({ requestDigest: hasher.digest(JSON.stringify([current.id,nodeId])), positions: [{ requestIndex: 0, nodeId, nodeFingerprint: current.nodes.find((row)=>row.nodeId===nodeId)!.nodeFingerprint, requestDigest: hasher.digest(nodeId) }] as const }),
    execute: async (current: CampaignCreationBatch, nodeId: string) => {
      const row = current.nodes.find((node) => node.nodeId === nodeId)!;
      const intent = row.intent!;
      const planned = current.plan.nodes.find((node)=>node.nodeId===nodeId)!;
      expect('state' in planned.payload && planned.payload.state).toBe('paused');
      calls.push(nodeId);
      const failed = nodeId === TARGET && failKeyword;
      const ambiguous = nodeId === GROUP && uncertainGroup;
      return CampaignCreationProviderResult.parse({ effect: 'irreversible_create', planId: current.plan.id,
        nodeId, executionId: current.id, attemptId: intent.id, providerCallId: intent.id,
        nodeFingerprint: row.nodeFingerprint, requestIndex: 0, requestDigest: intent.requestDigest,
        nodeRequestDigest: intent.nodeRequestDigest, outcome: ambiguous ? 'ambiguous' : failed ? 'authoritative_rejected' : 'succeeded',
        providerEntityId: failed || ambiguous ? null : String(900000 + current.plan.nodes.findIndex((node) => node.nodeId === nodeId)),
        providerEntityVersion: null, providerCode: failed ? 'INVALID_ARGUMENT' : null, sanitizedMessage: null,
        providerRequestId: null, responseDigest: hasher.digest('synthetic response'), startedAt: intent.reservedAt, completedAt: intent.reservedAt });
    },
    observe: async (current: CampaignCreationBatch, nodeId: string) => {
      reads.push(nodeId);
      const row = current.nodes.find((node) => node.nodeId === nodeId)!;
      const found = row.result?.outcome === 'succeeded' || (row.intent ? discovery === 'found' : preflightFound.has(nodeId));
      const ambiguous = row.intent && row.result?.outcome !== 'succeeded' && discovery === 'ambiguous';
      const matched = ambiguous ? 2 : found ? 1 : 0;
      const pending = observationPending && nodeId === GROUP;
      return { id: crypto.randomUUID(), mode: row.result?.outcome === 'succeeded' ? 'provider_id' as const : 'identity' as const,
        identityFingerprint: hasher.digest(nodeId), providerEntityId: found ? String(900000 + current.plan.nodes.findIndex((node) => node.nodeId === nodeId)) : null,
        requestDigest: provider.prepare(current,nodeId).requestDigest, responseDigest: hasher.digest('synthetic read'),
        observation: pending ? 'pending' as const : ambiguous ? 'ambiguous_readback' as const : found ? 'observed' as const : 'not_found' as const,
        complete: !pending, reason: null, accounting: { pages: 1, loaded: matched, parsed: matched, matched },
        startedAt: new Date(now()).toISOString(), observedAt: new Date(now()).toISOString() };
    },
  };
  const worker = () => createCampaignCreationWorker({ ledger, claimantId: id(299), policy: () => policy, provider: async () => provider, now });
  return { worker, ledger, calls, reads, policy, get batch() { return CampaignCreationBatch.parse(batch); },
    setGate: (value: boolean) => { gate = value; }, fail: () => { failKeyword = true; }, timeout: () => { uncertainGroup = true; },
    crash: () => { crashAfterReserve = true; }, observePending: (value: boolean) => { observationPending = value; },
    advance: (ms: number) => { clock += ms; }, discovery: (value: typeof discovery) => { discovery = value; },
    adoptOnPreflight: (nodeId: string) => { preflightFound.add(nodeId); },
    replace: (value: CampaignCreationBatch) => { batch = value; claim.batchId = value.id; } };
}
async function ticks(worker: ReturnType<typeof createCampaignCreationWorker>, count: number) {
  for (let i = 0; i < count; i++) expect((await worker.tick()).kind).not.toBe('fault');
}

describe('creation outbox source', () => {
  it('creates four paused resources once, in canonical order, with reconciled counts', async () => {
    const run = setup(); const worker = run.worker();
    expect(campaignCreationBatchSummary(run.batch).state).toBe('admitted');
    expect(await worker.tick()).toEqual({ kind: 'completed', attemptedCalls: 1 });
    expect(campaignCreationBatchSummary(run.batch).state).toBe('attempted');
    await ticks(worker, 7);
    expect(run.calls).toEqual([CAMPAIGN, GROUP, AD, TARGET]); expect(run.reads).toEqual(run.calls);
    expect(campaignCreationBatchSummary(run.batch)).toMatchObject({ state: 'observed', terminal: true,
      accounting: { parsed: 4, loaded: 4, attempted: 4, succeeded: 4, failed: 0, observed: 4 } });
    await ticks(run.worker(), 2); expect(run.calls).toHaveLength(4);
  });
  it('resumes after the ad group without duplicating the campaign or ad group', async () => {
    const run = setup(); await ticks(run.worker(), 4);
    expect(run.calls).toEqual([CAMPAIGN, GROUP]);
    await ticks(run.worker(), 4); expect(run.calls).toEqual([CAMPAIGN, GROUP, AD, TARGET]);
  });
  it('repeats an uncertain ad-group read by its returned identity, never the create', async () => {
    const run = setup(); run.observePending(true); await ticks(run.worker(), 5);
    expect(run.calls).toEqual([CAMPAIGN, GROUP]);
    run.observePending(false); await ticks(run.worker(), 5);
    expect(run.calls).toEqual([CAMPAIGN, GROUP, AD, TARGET]);
    expect(run.reads.filter((node) => node === GROUP)).toHaveLength(3);
    expect(campaignCreationBatchSummary(run.batch).accounting.observed).toBe(4);
  });
  it('waits out a lost-response reservation, then adopts its deterministic identity without a second POST', async () => {
    const run = setup(); run.timeout(); await ticks(run.worker(), 8);
    expect(run.calls).toEqual([CAMPAIGN, GROUP]); expect(run.reads).toEqual([CAMPAIGN]);
    expect(campaignCreationBatchSummary(run.batch)).toMatchObject({ terminal: false, accounting: { parsed: 4, loaded: 4, attempted: 2, uncertain: 1 } });
    run.advance(36_000); await ticks(run.worker(), 5);
    expect(run.calls).toEqual([CAMPAIGN, GROUP, AD, TARGET]);
    expect(run.batch.nodes.find((row) => row.nodeId === GROUP)?.result?.outcome).toBe('ambiguous');
    expect(campaignCreationBatchSummary(run.batch)).toMatchObject({ state: 'observed', accounting: { adopted: 1, observed: 4 } });
  });
  it('does not acquire a second create permission after a crash just after reservation', async () => {
    const run = setup(); run.crash(); expect((await run.worker().tick()).kind).toBe('fault');
    await ticks(run.worker(), 3); expect(run.calls).toHaveLength(0);
    expect(campaignCreationBatchSummary(run.batch).accounting.attempted).toBe(1);
  });
  it('records partial failure and retries only the failed keyword with separate parent evidence', async () => {
    const run = setup(); run.fail(); await ticks(run.worker(), 8);
    const parent = run.batch;
    expect(campaignCreationBatchSummary(parent)).toMatchObject({ state: 'partial_failed', failedNodeIds: [TARGET], accounting: { succeeded: 3, observed: 3, failed: 1 } });
    const child = CampaignCreationBatch.parse({ ...parent, id: id(300), nodes: parent.nodes.filter((row) => row.nodeId === TARGET)
      .map((row) => ({ ...row, intent: null, result: null, observation: null, observations: [] })),
    lineage: { parentBatchId: parent.id, planFingerprint: parent.plan.fingerprint, nodeIds: [TARGET], inheritedResources: parent.nodes
      .filter((row) => row.observation?.observation === 'observed').map((row) => ({ batchId: parent.id, nodeId: row.nodeId,
        nodeFingerprint: row.nodeFingerprint, providerEntityId: row.result!.providerEntityId!, requestDigest: row.intent!.requestDigest, observedAt: row.observation!.observedAt })) } });
    const retry = setup(child); await ticks(retry.worker(), 2);
    expect(retry.calls).toEqual([TARGET]); expect(parent.nodes).toHaveLength(4);
    expect(campaignCreationBatchSummary(retry.batch)).toMatchObject({ state: 'observed', accounting: { parsed: 1, loaded: 1, attempted: 1, succeeded: 1, observed: 1 } });
    expect(retry.reads).toEqual([TARGET,TARGET]);
  });
  it('refuses closed runtime gates and a non-allowlisted profile before preparation or POST', async () => {
    const run = setup(); run.policy.dispatchEnabled = false; run.policy.reconcileEnabled = false;
    expect((await run.worker().tick()).kind).toBe('disabled'); expect(run.ledger.claim).not.toHaveBeenCalled();
    run.policy.dispatchEnabled = true; run.policy.profileIds = [id(999)];
    expect((await run.worker().tick()).kind).toBe('deferred'); expect(run.calls).toHaveLength(0);
    run.policy.profileIds = [run.batch.plan.profileId]; run.setGate(false);
    await run.worker().tick(); expect(run.calls).toHaveLength(0);
    expect(run.batch.nodes[0]!.refusal).toBe('gate_closed');
  });
  it('requires two empty observations 60 seconds apart, then an approved child reads before creating', async () => {
    const run = setup(); run.timeout(); run.discovery('absent'); await ticks(run.worker(), 3);
    run.advance(36_000); await ticks(run.worker(), 1);
    expect(run.batch.nodes.find((row) => row.nodeId === GROUP)?.observation?.observation).toBe('not_found');
    run.advance(59_000); await ticks(run.worker(), 1); expect(run.reads.filter((id) => id === GROUP)).toHaveLength(1);
    run.advance(1000); await ticks(run.worker(), 1);
    const parent = run.batch;
    expect(campaignCreationBatchSummary(parent)).toMatchObject({ state: 'needs_attention', terminal: true, accounting: { attempted: 2, blocked: 2 } });
    await ticks(run.worker(), 3); expect(run.calls).toEqual([CAMPAIGN,GROUP]);
    const selection = campaignCreationRetrySelection(parent); expect(selection.nodeIds).toEqual([GROUP,AD,TARGET]);
    const inherited = parent.nodes.filter((row) => row.observation?.observation === 'observed').map((row) => ({ batchId: parent.id,
      nodeId: row.nodeId, nodeFingerprint: row.nodeFingerprint, providerEntityId: row.observation!.providerEntityId!,
      requestDigest: row.observation!.requestDigest, observedAt: row.observation!.observedAt }));
    const child = CampaignCreationBatch.parse({ ...parent, id: id(301), nodes: parent.nodes.filter((row) => selection.nodeIds.includes(row.nodeId))
      .map((row) => ({ ...row, intent: null, result: null, observation: null, observations: [], refusal: null })),
      lineage: { parentBatchId: parent.id, planFingerprint: parent.plan.fingerprint, nodeIds: selection.nodeIds, inheritedResources: inherited } });
    const retry = setup(child); retry.adoptOnPreflight(GROUP); await ticks(retry.worker(), 5);
    expect(retry.calls).toEqual([AD,TARGET]);
    expect(campaignCreationBatchSummary(retry.batch)).toMatchObject({ state: 'observed', accounting: { requested: 3, attempted: 2, adopted: 1, observed: 3 } });
  });
  it('refuses ambiguous identity matches permanently and never offers a retry', async () => {
    const run = setup(); run.timeout(); run.discovery('ambiguous'); await ticks(run.worker(), 3);
    run.advance(36_000); await ticks(run.worker(), 4);
    expect(run.calls).toEqual([CAMPAIGN,GROUP]);
    expect(run.batch.nodes.find((row) => row.nodeId === GROUP)?.observation?.observation).toBe('ambiguous_readback');
    expect(campaignCreationBatchSummary(run.batch).state).toBe('needs_attention');
    expect(campaignCreationRetrySelection(run.batch).available).toBe(false);
  });
});
