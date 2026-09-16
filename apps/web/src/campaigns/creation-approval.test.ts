import { afterEach, expect, it, vi } from 'vitest';
import type { AuthenticatedEditorTransaction } from '@wizard-ads/db';
import { CampaignDraft, CampaignCreationAdmissionValidation } from '@wizard-ads/shared';
import { builderContext, creationBatchFixture, validatedDraft, fixtureTime } from '../screens/campaigns/render-fixture';
import { revalidateCreationDraft } from './creation-approval';
import { savedCampaignCreationReview } from './review';
afterEach(()=>vi.useRealTimers());

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
