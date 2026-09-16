// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { campaignCreationReviewFreshness } from '@wizard-ads/shared/campaign-creation-approval';
import { CreationConfirm, CreationResult, KeywordRetry } from './creation-states';
import { fixtureReview, measuredCreationChecks, validationChecks, creationBatchFixture } from '../campaigns/render-fixture';
import { campaignCreationResult } from '../../campaigns/creation-result';

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
      expect((screen.getByRole('button',{name:'Review resource retry'}) as HTMLButtonElement).disabled).toBe(state==='ambiguous');
    }
  });
  it('reviews all four uncertain-campaign resources and submits only on the exact explicit control',()=>{
    const batch=creationBatchFixture('uncertain');const retry=vi.fn();
    render(<KeywordRetry batch={batch} plan={batch.plan} executor={{available:true,create:noop,retry}} onBack={noop}/>);
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(5);expect(retry).not.toHaveBeenCalled();
    expect(screen.getByText(/A delayed original resource could appear later and cause a duplicate/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Yes, retry 4 resources in Amazon'}));expect(retry).toHaveBeenCalledOnce();
  });
});
