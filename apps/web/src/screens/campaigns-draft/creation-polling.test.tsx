// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { DraftReady } from './view';
import { builderContext, validatedDraft, fixtureReview, measuredCreationChecks, creationBatchFixture } from '../campaigns/render-fixture';
import type { DraftScreenData } from './load';

const client = vi.hoisted(() => ({ approve: vi.fn(), read: vi.fn(), refresh: vi.fn(), draft: vi.fn() }));
vi.mock('../../campaigns/creation-client', () => ({ approveCampaignCreation: client.approve, fetchCampaignCreation: client.read, refreshCampaignCreationReview: client.refresh }));
vi.mock('../../campaigns/client', () => ({ draftRequest: client.draft, downloadDraft: vi.fn() }));
function data(step = 'result'): Extract<DraftScreenData, { view: 'ready' }> {
  const batch = creationBatchFixture('admitted');
  const draft = { ...validatedDraft, id: batch.draftId, plan: batch.plan,
    validation: { ...validatedDraft.validation!, planFingerprint: batch.plan.fingerprint } };
  return { view: 'ready', context: builderContext, draft, review: fixtureReview, executorAvailable: true,
    creationBatch: batch, creationValidation: { ...draft.validation, checks: measuredCreationChecks }, step };
}
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });
describe('recorded creation status polling', () => {
  it('reloads server-owned review evidence after validation without approving a batch', async () => {
    const source = data('review');
    client.draft.mockResolvedValue({ ...source.draft, revision: source.draft.revision + 1 });
    render(<DraftReady data={source} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Validate draft$/ })); });
    expect(client.draft).toHaveBeenCalledExactlyOnceWith({action:'validate',profileId:source.draft.profileId,id:source.draft.id,expectedRevision:source.draft.revision});
    expect(client.refresh).toHaveBeenCalledExactlyOnceWith('review');
    expect(client.approve).not.toHaveBeenCalled();
  });
  it('reloads current retry review before showing the terminal control', async () => {
    const source = {...data(),creationBatch:creationBatchFixture('partial')};
    render(<DraftReady data={source} />);
    fireEvent.click(screen.getByRole('button', { name:'Review keyword retry' }));
    expect(client.refresh).toHaveBeenCalledExactlyOnceWith('retry');
    expect(client.approve).not.toHaveBeenCalled();
  });
  it('polls after two seconds, renders completion and stops at the terminal batch', async () => {
    vi.useFakeTimers(); client.read.mockResolvedValue(creationBatchFixture('complete'));
    render(<DraftReady data={data()} />);
    expect(client.read).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(client.read).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'Campaign created' })).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(client.read).toHaveBeenCalledTimes(1); expect(client.approve).not.toHaveBeenCalled();
  });
  it('stops a pending read when the result screen unmounts', async () => {
    vi.useFakeTimers(); client.read.mockResolvedValue(creationBatchFixture('admitted'));
    const screen = render(<DraftReady data={data()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(client.read).toHaveBeenCalledTimes(2);
    const signal = client.read.mock.calls[0]![2] as AbortSignal;
    screen.unmount(); expect(signal.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(client.read).toHaveBeenCalledTimes(2); expect(client.approve).not.toHaveBeenCalled();
  });
  it('admits only the displayed draft binding after the explicit confirmation', async () => {
    const source = data('confirm');
    client.approve.mockResolvedValue(creationBatchFixture('complete'));
    render(<DraftReady data={source} />);
    expect(client.approve).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Yes, create 1 campaign in Amazon' })); });
    expect(client.approve).toHaveBeenCalledExactlyOnceWith({ action: 'create', profileId: source.draft.profileId,
      draftId: source.draft.id, expectedRevision: source.draft.revision, planFingerprint: source.draft.plan.fingerprint });
  });
});
