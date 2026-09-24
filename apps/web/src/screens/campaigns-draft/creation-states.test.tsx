// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { campaignCreationReviewFreshness } from '@wizard-ads/shared/campaign-creation-approval';
import { CampaignCreationBatch, CampaignDraft } from '@wizard-ads/shared';
import { CreationConfirm, CreationResult, KeywordRetry } from './creation-states';
import { fixtureReview, measuredCreationChecks, validationChecks, validatedDraft, builderContext, fixtureTime, creationBatchFixture } from '../campaigns/render-fixture';
import { campaignCreationResult } from '../../campaigns/creation-result';
import { savedCampaignCreationReview } from '../../campaigns/review';
afterEach(() => { cleanup(); vi.useRealTimers(); });

const noop = () => {};
describe('guarded campaign creation states', () => {
  it.each(['available','unavailable','stale','blocked','unmeasured'] as const)('renders confirmation %s with exactly one Amazon control', (state) => {
    const create=vi.fn();
    const stale={...fixtureReview,checkedAt:fixtureReview.plan.expiresAt};
    const review=state==='stale'?{...stale,freshness:campaignCreationReviewFreshness(stale)}:fixtureReview;
    const checks=state==='unmeasured'?validationChecks:state==='blocked'?measuredCreationChecks.map((row,i)=>i?row:{...row,status:'blocked' as const,blocking:true}):measuredCreationChecks;
    render(<CreationConfirm review={review} checks={checks} executor={state==='unavailable'?{available:false}:{available:true,create,retry:noop}} onExport={noop} onBack={noop}/>);
    const button=screen.getByRole('button',{name:'Yes, create 1 campaign in Amazon'}) as HTMLButtonElement;
    expect(screen.getAllByRole('button').filter((row)=>row.textContent?.includes('in Amazon'))).toHaveLength(1);
    const allowed = state === 'available' || state === 'unmeasured';
    expect(button.disabled).toBe(!allowed);fireEvent.click(button);expect(create).toHaveBeenCalledTimes(allowed?1:0);
    if (state === 'unmeasured') {
      expect(screen.getByText('Checks not measured')).toBeTruthy();
      expect(screen.getAllByText(/Arcana has no measured evidence for this check/)).toHaveLength(4);
    }
  });
  it.each(['admitted','partial','complete'] as const)('renders %s resources and reconciles every row', (state) => {
    const batch=creationBatchFixture(state);const result=campaignCreationResult(batch);
    render(<CreationResult batch={batch} result={result} onRetry={noop} onBack={noop}/>);
    expect(screen.getByRole('heading',{name:state==='admitted'?'Campaign creation in progress':state==='partial'?'Campaign partially created':'Campaign created'})).toBeTruthy();
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(5);
    expect(screen.getByText(/Parsed 4 · Loaded 4 · Attempted/)).toBeTruthy();
    expect(screen.queryAllByRole('link',{name:/in the campaign grid/})).toHaveLength(state==='admitted'?0:1);
  });
  it('lists the one failed keyword and retains the parent reuse explanation',()=>{
    const batch=creationBatchFixture('partial');
    render(<KeywordRetry plan={batch.plan} result={campaignCreationResult(batch)} executor={{available:true,create:noop,retry:noop}} onBack={noop}/>);
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(2);
    expect(screen.getByRole('button',{name:'Yes, retry 1 keyword in Amazon'})).toBeTruthy();
    expect(screen.getByText('Reuse the created campaign')).toBeTruthy();
  });
  it.each(['uncertain','ambiguous','adopted'] as const)('renders %s directly from immutable batch evidence', (state) => {
    const batch=creationBatchFixture(state);
    render(<CreationResult batch={batch} onRetry={noop} onBack={noop}/>);
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(5);
    if(state==='adopted') {
      expect(screen.getByText(/Attempted 3 · Succeeded 4/)).toBeTruthy();
      expect(screen.getByText(/Existing resources adopted 1/)).toBeTruthy();
    } else {
      expect(screen.getByRole('heading',{name:'Campaign creation needs attention'})).toBeTruthy();
      expect((screen.getByRole('button',{name:'Review resource recovery'}) as HTMLButtonElement).disabled).toBe(state==='ambiguous');
      expect(screen.queryByRole('button',{name:/keyword retry/})).toBeNull();
    }
  });
  it('reviews all four uncertain-campaign resources and submits only on the exact explicit control',()=>{
    const batch=creationBatchFixture('uncertain');const retry=vi.fn();
    render(<KeywordRetry batch={batch} plan={batch.plan} executor={{available:true,create:noop,retry}} onBack={noop}/>);
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(5);expect(retry).not.toHaveBeenCalled();
    expect(screen.getByText(/A delayed original resource could appear later and cause a duplicate/)).toBeTruthy();
    expect(screen.getByRole('heading',{name:'Review resource recovery'})).toBeTruthy();
    expect(screen.getByText('Resource recovery is a separate approval.')).toBeTruthy();
    expect(screen.getAllByRole('button').filter((row)=>row.textContent?.includes('in Amazon')).map((row)=>row.textContent)).toEqual(['Yes, recover 4 resources in Amazon']);
    fireEvent.click(screen.getByRole('button',{name:'Yes, recover 4 resources in Amazon'}));expect(retry).toHaveBeenCalledOnce();
  });
  it('keeps the exact keyword retry control for a keyword-only child and never offers recovery wording',()=>{
    const batch=creationBatchFixture('partial');const retry=vi.fn();
    render(<KeywordRetry batch={batch} plan={batch.plan} executor={{available:true,create:noop,retry}} onBack={noop}/>);
    expect(screen.getByRole('heading',{name:'Review keyword retry'})).toBeTruthy();
    expect(screen.getAllByRole('button').filter((row)=>row.textContent?.includes('in Amazon')).map((row)=>row.textContent)).toEqual(['Yes, retry 1 keyword in Amazon']);
    expect(screen.queryByText(/recover/i)).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'Yes, retry 1 keyword in Amazon'}));expect(retry).toHaveBeenCalledOnce();
  });
});

describe('displayed review evidence expires while the confirmation is open', () => {
  // The persisted validation of this revision on a provider-bound plan, displayed with its five-minute window.
  const plan = creationBatchFixture('admitted').plan;
  const displayed = savedCampaignCreationReview(CampaignDraft.parse({ ...validatedDraft, plan, validation: { ...validatedDraft.validation!, planFingerprint: plan.fingerprint } }),
    builderContext.profile.label, fixtureTime, plan.providerScope);
  it('disables creation at the evidence deadline and offers only a refresh', async () => {
    vi.useFakeTimers({ now: Date.parse('2030-01-01T00:00:00.000Z') });
    const create=vi.fn(); const refresh=vi.fn();
    render(<CreationConfirm review={displayed} checks={validatedDraft.validation!.checks} executor={{available:true,create,retry:noop}} onRefresh={refresh} onExport={noop} onBack={noop}/>);
    const button=()=>screen.getByRole('button',{name:'Yes, create 1 campaign in Amazon'}) as HTMLButtonElement;
    // The window runs from the server check time, not the browser clock set years later.
    expect(displayed.freshness.status).toBe('current'); expect(button().disabled).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(299_000); });
    expect(button().disabled).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(button().disabled).toBe(true);
    fireEvent.click(button()); expect(create).not.toHaveBeenCalled();
    expect(screen.getByText(/Expired evidence cannot be approved/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Refresh review evidence'})); expect(refresh).toHaveBeenCalledOnce();
    expect(screen.getAllByRole('button').filter((row)=>row.textContent?.includes('in Amazon'))).toHaveLength(1);
  });
  it('disables a retry once its displayed evidence expires', async () => {
    vi.useFakeTimers();
    const batch=creationBatchFixture('partial');const retry=vi.fn();const refresh=vi.fn();
    const draft=CampaignDraft.parse({...validatedDraft,status:'approved',plan:batch.plan,validation:{...validatedDraft.validation!,planFingerprint:batch.plan.fingerprint}});
    const review=savedCampaignCreationReview(draft,builderContext.profile.label,fixtureTime,batch.plan.providerScope);
    render(<KeywordRetry batch={CampaignCreationBatch.parse(batch)} plan={batch.plan} review={review} onRefresh={refresh} executor={{available:true,create:noop,retry}} onBack={noop}/>);
    const button=()=>screen.getByRole('button',{name:'Yes, retry 1 keyword in Amazon'}) as HTMLButtonElement;
    expect(button().disabled).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    expect(button().disabled).toBe(true); fireEvent.click(button()); expect(retry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'Refresh review evidence'})); expect(refresh).toHaveBeenCalledOnce();
  });
});
