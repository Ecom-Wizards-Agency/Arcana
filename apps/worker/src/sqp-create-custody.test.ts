import { describe, expect, it, vi } from 'vitest';
import { SpApiAmbiguousOutcome, SpApiAuthError, SpApiError } from '@wizard-ads/sp-api';
import { InMemorySqpWorkflowCheckpoints, runSqpRequestWorkflow, type SqpWorkflowCheckpoint,
  type SqpWorkflowDependencies } from './sqp.js';

const payload = { type: 'sqp.request' as const, orgId: '11111111-1111-4111-8111-111111111111',
  profileId: '22222222-2222-4222-8222-222222222222', marketplaceId: 'synthetic-marketplace',
  asins: ['B000000001'], weekStart: '2026-08-16', weekEnd: '2026-08-22' };
function dependencies(createReport: SqpWorkflowDependencies['api']['createReport']) {
  return { api: { createReport, getReport: async () => ({ reportId: 'synthetic-report', reportType: null,
    processingStatus: 'IN_PROGRESS', reportDocumentId: null, createdTime: null }),
    getReportDocument: vi.fn(), downloadReportDocument: vi.fn() },
    checkpoints: new InMemorySqpWorkflowCheckpoints(), providerGate: { beforeCall: async () => {} },
    data: { listVocabulary: vi.fn(), promoteFacts: vi.fn(), verifyFacts: vi.fn(), listPpcFacts: vi.fn(), persistProposals: vi.fn() },
    now: () => new Date('2026-08-23T00:00:00Z'),
  } satisfies SqpWorkflowDependencies;
}

describe('SP report create custody', () => {
  it('persists intent before POST and refuses a resumed ambiguous intent', async () => {
    const create = vi.fn(async () => { throw new SpApiAmbiguousOutcome('transport'); });
    const deps = dependencies(create);
    const save = vi.spyOn(deps.checkpoints,'save');
    await expect(runSqpRequestWorkflow(payload,deps)).rejects.toBeInstanceOf(SpApiAmbiguousOutcome);
    expect(save.mock.calls[0]?.[0].batches[0]?.status).toBe('creating');
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0]!);
    await expect(runSqpRequestWorkflow(payload,deps)).rejects.toBeInstanceOf(SpApiAmbiguousOutcome);
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('retries only a definitively rejected create after durable reset', async () => {
    const create = vi.fn().mockRejectedValueOnce(new SpApiError('synthetic throttle',429,true,7))
      .mockResolvedValue({ reportId: 'synthetic-report' });
    const deps = dependencies(create);
    await expect(runSqpRequestWorkflow(payload,deps)).rejects.toBeInstanceOf(SpApiError);
    expect(await runSqpRequestWorkflow(payload,deps)).toMatchObject({ status: 'pending' });
    expect(create).toHaveBeenCalledTimes(2);
  });
  it('resets intent when authentication fails before the Reports request', async () => {
    const create = vi.fn().mockRejectedValueOnce(new SpApiAuthError('synthetic authentication unavailable', 429))
      .mockResolvedValue({ reportId: 'synthetic-report' });
    const deps = dependencies(create);
    await expect(runSqpRequestWorkflow(payload,deps)).rejects.toBeInstanceOf(SpApiAuthError);
    expect(await runSqpRequestWorkflow(payload,deps)).toMatchObject({ status: 'pending' });
    expect(create).toHaveBeenCalledTimes(2);
  });
  it('quarantines a lost report-id write without repeating the POST', async () => {
    const create = vi.fn(async () => ({ reportId: 'synthetic-report' }));
    const deps = dependencies(create); let persisted: SqpWorkflowCheckpoint | null = null;
    deps.checkpoints.load = async () => structuredClone(persisted);
    deps.checkpoints.save = async (checkpoint) => {
      if (checkpoint.batches[0]?.status === 'requested') throw new Error('synthetic lost write');
      persisted = structuredClone(checkpoint);
    };
    await expect(runSqpRequestWorkflow(payload,deps)).rejects.toMatchObject({ phase: 'provider-id-persistence' });
    await expect(runSqpRequestWorkflow(payload,deps)).rejects.toMatchObject({ phase: 'checkpoint' });
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('adopts an exact committed ID after losing its persistence response', async () => {
    const create = vi.fn(async () => ({ reportId: 'synthetic-report' }));
    const deps = dependencies(create); const save = deps.checkpoints.save.bind(deps.checkpoints);
    deps.checkpoints.save = async (checkpoint) => {
      await save(checkpoint);
      if (checkpoint.batches[0]?.status === 'requested') throw new Error('synthetic lost response');
    };
    // The create checkpoint readback succeeds; later polling can retry independently.
    await expect(runSqpRequestWorkflow(payload,deps)).rejects.toThrow('synthetic lost response');
    deps.checkpoints.save = save;
    expect(await runSqpRequestWorkflow(payload,deps)).toMatchObject({ status: 'pending' });
    expect(create).toHaveBeenCalledTimes(1);
  });
});
