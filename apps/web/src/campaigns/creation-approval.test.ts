import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedEditorTransaction } from '@wizard-ads/db';
import { CampaignDraft, CampaignCreationAdmissionValidation, type CampaignCreationBatchRequest } from '@wizard-ads/shared';
import { builderContext, creationBatchFixture, validatedDraft, fixtureTime } from '../screens/campaigns/render-fixture';
import { approveSavedCampaignCreation, revalidateCreationDraft } from './creation-approval';
import { savedCampaignCreationReview } from './review';

const db = vi.hoisted(() => ({ read: vi.fn(), find: vi.fn(), admit: vi.fn(), gate: vi.fn(), scope: vi.fn(), batch: vi.fn() }));
vi.mock('@wizard-ads/db', async (original) => ({ ...await original<object>(), readCampaignDraft: db.read,
  findCampaignCreationAdmission: db.find, admitCampaignCreation: db.admit, readCampaignCreationGate: db.gate,
  readCampaignCreationProviderScope: db.scope, readCampaignCreationBatch: db.batch }));
vi.mock('./data', () => ({ loadCampaignBuilderContext: vi.fn(async () => builderContext) }));
afterEach(()=>{ vi.useRealTimers(); vi.resetAllMocks(); });

it.each(['partial','uncertain'] as const)('refreshes only current evidence for an approved %s batch without replacing the frozen draft',async(state)=>{
  vi.useFakeTimers();vi.setSystemTime(new Date(Date.parse(fixtureTime)+600_000));
  const batch=creationBatchFixture(state);
  const draft=CampaignDraft.parse({...validatedDraft,status:'approved',plan:batch.plan,
    validation:{...validatedDraft.validation!,planFingerprint:batch.plan.fingerprint}});
  const before=JSON.stringify(draft);
  const name=batch.plan.nodes.find(node=>node.kind==='campaign.create')!.payload.name;
  const array=vi.fn((ids:unknown[])=>ids);
  const sql=Object.assign(vi.fn(async()=>array.mock.calls[0]?.[0].length?[]:[{name}]),{array});
  const context={sql,actor:{orgId:draft.orgId,userId:draft.createdBy}} as unknown as AuthenticatedEditorTransaction;
  expect(savedCampaignCreationReview(draft,'Synthetic profile',new Date().toISOString(),batch.plan.providerScope).freshness.status).not.toBe('current');
  const validation=await revalidateCreationDraft(context,draft,builderContext,batch);
  expect(CampaignCreationAdmissionValidation.safeParse(validation).success).toBe(true);
  expect(validation.checks.filter(check=>check.status==='not_measured')).toHaveLength(4);
  expect(validation.checks).toHaveLength(12);
  expect(validation.planFingerprint).toBe(draft.plan.fingerprint);
  expect(savedCampaignCreationReview({...draft,validation},'Synthetic profile',new Date().toISOString(),batch.plan.providerScope).freshness.status).toBe('current');
  expect(JSON.stringify(draft)).toBe(before);expect(sql).toHaveBeenCalledTimes(1);
  expect(array).toHaveBeenCalledExactlyOnceWith(state==='partial'?['29000']:[]);
  const first=await revalidateCreationDraft(context,draft,builderContext,null);
  expect(first.checks.find(check=>check.id==='unique-name')?.status).toBe(state==='partial'?'passed':'blocked');
});

describe('admission binds the review evidence the operator saw', () => {
  const batch = creationBatchFixture('partial');
  const displayed = (status: 'validated' | 'approved') => CampaignDraft.parse({ ...validatedDraft, status, plan: batch.plan,
    validation: { ...validatedDraft.validation!, planFingerprint: batch.plan.fingerprint } });
  function context(draft: CampaignDraft) {
    const array = vi.fn((ids: unknown[]) => ids);
    const sql = Object.assign(vi.fn(async (parts: TemplateStringsArray) => parts.join('').includes('for update') ? [{ id: draft.id }] : []), { array });
    return { sql, actor: { orgId: draft.orgId, userId: draft.createdBy } } as unknown as AuthenticatedEditorTransaction;
  }
  const create = (draft: CampaignDraft): CampaignCreationBatchRequest => ({ action: 'create', profileId: draft.profileId, draftId: draft.id,
    expectedRevision: draft.revision, planFingerprint: draft.plan.fingerprint });
  function arrange(draft: CampaignDraft) {
    db.read.mockResolvedValue(draft); db.find.mockResolvedValue(null); db.gate.mockResolvedValue({ available: true, reason: null });
    db.scope.mockResolvedValue(batch.plan.providerScope); db.batch.mockResolvedValue(batch); db.admit.mockResolvedValue(batch);
  }
  it('refuses a confirmation whose displayed evidence expired and never enqueues a batch', async () => {
    const draft = displayed('validated'); arrange(draft);
    vi.useFakeTimers({ now: Date.parse(fixtureTime) + 600_000 });
    await expect(approveSavedCampaignCreation(context(draft), create(draft))).rejects.toMatchObject({ code: 'freshness_not_current' });
    expect(db.admit).not.toHaveBeenCalled(); expect(db.gate).not.toHaveBeenCalled();
    // One millisecond before the deadline the same evidence is still admissible.
    vi.setSystemTime(Date.parse(fixtureTime) + 299_999);
    await approveSavedCampaignCreation(context(draft), create(draft));
    expect(db.admit).toHaveBeenCalledOnce();
  });
  it('admits the displayed evidence itself, never regenerated evidence', async () => {
    const draft = displayed('validated'); arrange(draft);
    vi.useFakeTimers({ now: Date.parse(fixtureTime) + 60_000 });
    const tx = context(draft);
    await approveSavedCampaignCreation(tx, create(draft));
    expect(db.admit).toHaveBeenCalledExactlyOnceWith(tx, create(draft), draft.validation);
    expect(db.admit.mock.calls[0]![2].checkedAt).toBe(fixtureTime);
  });
  it('refuses an expired retry review without admitting the child batch', async () => {
    const draft = displayed('approved'); arrange(draft);
    vi.useFakeTimers({ now: Date.parse(fixtureTime) + 600_000 });
    const retry: CampaignCreationBatchRequest = { ...create(draft), action: 'retry', parentBatchId: batch.id, nodeIds: [batch.nodes[3]!.nodeId] };
    await expect(approveSavedCampaignCreation(context(draft), retry)).rejects.toMatchObject({ code: 'freshness_not_current' });
    expect(db.admit).not.toHaveBeenCalled();
  });
  it('replays an already recorded admission without re-admitting expired evidence', async () => {
    const draft = displayed('approved'); arrange(draft); db.find.mockResolvedValue(batch);
    vi.useFakeTimers({ now: Date.parse(fixtureTime) + 600_000 });
    expect(await approveSavedCampaignCreation(context(draft), create(draft))).toBe(batch);
    expect(db.admit).not.toHaveBeenCalled();
  });
});
