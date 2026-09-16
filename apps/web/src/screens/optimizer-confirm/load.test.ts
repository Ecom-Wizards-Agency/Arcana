import { beforeEach, expect, it, vi } from 'vitest';
import type { ScreenActor } from '../../server/page-read';
import { profile } from '../synthetic-render-fixtures';
import { restoreApprovalFixture, restoreExportFixture } from '../../writes/approval-fixtures';
import { spWriteApprovalFixtures } from '../../writes/approval-fixtures';
const reads = vi.hoisted(() => ({ recorded: vi.fn(), restore: vi.fn(), optimizer: vi.fn(), fallback: vi.fn() }));
vi.mock('@wizard-ads/db', () => ({ assertOptimizerApplyBatch: reads.optimizer, assertRestoreBatchBinding: reads.restore, readRestoreExportPreview: reads.fallback, readOptimizerReview: vi.fn().mockResolvedValue(null), readOptimizerExports: vi.fn().mockResolvedValue([]), readOptimizerRetryExclusions: vi.fn().mockResolvedValue([]) }));
vi.mock('../../writes/http', () => ({ readSpWriteConfirmationSnapshot: reads.recorded }));
vi.mock('../../../app/_lib/profiles', () => ({ listProfiles: vi.fn().mockResolvedValue([profile]) }));
import { load } from './load';
const restore = await restoreApprovalFixture();
const fallback = await restoreExportFixture();
const batchId = restore.preview.plan.source.kind === 'apply_batch' ? restore.preview.plan.source.applyBatchId : '';
const context = { actor: { orgId: restore.preview.plan.orgId } };
const access = { entry: { state: 'ok' }, actor: () => context.actor, requestedProfile: profile.id, selectProfile: () => profile,
  readSql: async (read: (sql: unknown) => unknown) => read({}), snapshot: async (read: (value: unknown) => unknown) => read(context) } as unknown as ScreenActor;
beforeEach(() => { vi.clearAllMocks(); reads.recorded.mockResolvedValue(restore); reads.restore.mockResolvedValue(undefined); reads.optimizer.mockResolvedValue(undefined); reads.fallback.mockResolvedValue(fallback); });
it('binds the restore confirmation to its route source batch, plan and selected profile before rendering', async () => {
  const data = await load(access, { params: { batchId }, searchParams: { plan: restore.preview.plan.id } });
  expect(data.view).toBe('ready');
  expect(reads.restore).toHaveBeenCalledExactlyOnceWith(context, { orgId: context.actor.orgId, profileId: profile.id, batchId, planId: restore.preview.plan.id });
  expect(reads.optimizer).not.toHaveBeenCalled();
});
it('fails closed when a saved restore is placed under another source route', async () => {
  reads.restore.mockRejectedValue(new Error('source_changed'));
  await expect(load(access, { params: { batchId: '33333333-3333-4333-8333-333333333333' }, searchParams: { plan: restore.preview.plan.id } })).rejects.toThrow('source_changed');
  expect(reads.restore).toHaveBeenCalledOnce();
  expect(reads.optimizer).not.toHaveBeenCalled();
  expect(reads.fallback).not.toHaveBeenCalled();
});
it('keeps ordinary optimizer confirmation scoped through its existing batch admission', async () => {
  const optimizer = (await spWriteApprovalFixtures()).ready;
  reads.recorded.mockResolvedValue(optimizer);
  const data = await load(access, { params: { batchId }, searchParams: { plan: optimizer.preview.plan.id } });
  expect(data.view).toBe('ready');
  expect(reads.optimizer).toHaveBeenCalledOnce();
  expect(reads.restore).not.toHaveBeenCalled();
});
it('renders export-only confirmation only after the profile-scoped fallback check', async () => {
  const data = await load(access, { params: { batchId }, searchParams: { restoreExport: '1' } });
  expect(data.view).toBe('export-only');
  expect(reads.fallback).toHaveBeenCalledExactlyOnceWith(context, { profileId: profile.id, batchId });
  expect(reads.recorded).not.toHaveBeenCalled();
  reads.fallback.mockRejectedValue(new Error('Profile writes are enabled'));
  await expect(load(access, { params: { batchId }, searchParams: { restoreExport: '1' } })).rejects.toThrow('Profile writes are enabled');
});
