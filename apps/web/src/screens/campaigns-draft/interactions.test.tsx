// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CampaignBuilderResult } from '@wizard-ads/shared';
import { BidEditor } from './bid';
import { CreationConfirm, CreationResult, KeywordRetry } from './creation-states';
import { DraftReady } from './view';
import { renderToStaticMarkup } from 'react-dom/server';
import { campaignVisualCases } from '../campaigns/visual-cases';
import { builderContext, builderRecipe, savedDraft, validatedDraft, blockedDraft, fixtureReview, validationChecks, creationResult } from '../campaigns/render-fixture';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const noop = () => {};
describe('bid and immutable draft interactions', () => {
  it('blocks inconsistent CPC until the operator selects manual and uses the exact entered bid', () => {
    const use = vi.fn();
    render(<BidEditor keyword={{ ...builderRecipe.keywords[0]!, basis: 'keyword_cpc' }} evidence={{ ...builderContext.bidEvidence[0]!, reportedCpc: 1.2 }} bounds={{ floor: 0.12, ceiling: 0.96, exposureCeiling: 2.4, decimalPlaces: 2 }} currency="USD" topOfSearch={140} audienceAdjustment={0} onUse={use} onCancel={noop} />);
    expect((screen.getByRole('button', { name: 'Use this bid' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'View bid calculation' })); expect(screen.getByText('Source totals do not reconcile')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Enter bid manually' }));
    fireEvent.change(screen.getByLabelText('Starting bid amount'), { target: { value: '0.48' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use this bid' })); expect(use).toHaveBeenCalledWith({ text: builderRecipe.keywords[0]!.text, bid: 0.48, basis: 'manual' });
    fireEvent.change(screen.getByLabelText('Starting bid amount'), { target: { value: '' } });
    expect((screen.getByRole('button', { name: 'Use this bid' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('submits edited values with the saved revision and requires server revalidation', async () => {
    const fetch = vi.fn(async () => Response.json(blockedDraft)); vi.stubGlobal('fetch', fetch);
    render(<DraftReady data={{ view: 'ready', context: builderContext, draft: validatedDraft, review: fixtureReview, executorAvailable: false, step: 'review' }} initiallyEditing />);
    fireEvent.change(screen.getByLabelText('Draft daily budget'), { target: { value: '0.3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const request = fetch.mock.calls[0] as unknown as [string, RequestInit]; const body = JSON.parse(String(request[1].body));
    expect(request[0]).toBe('/api/campaigns/drafts'); expect(body).toMatchObject({ action: 'save', expectedRevision: validatedDraft.revision, validate: true, recipe: { dailyBudget: 0.3 } });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Fix draft issues' })).toBeTruthy());
    expect((screen.getByRole('button', { name: 'Continue to confirmation' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('keeps edits in recipe order when graph nodes have unrelated stable identities', () => {
    const names = { '1': 'second saved campaign', '0': 'first saved campaign' };
    render(<DraftReady data={{ view: 'ready', context: builderContext, draft: { ...savedDraft, recipe: { ...savedDraft.recipe, names } }, review: fixtureReview, executorAvailable: false, step: 'review' }} initiallyEditing />);
    expect((screen.getByLabelText('Draft campaign name 1') as HTMLInputElement).value).toBe(names['0']);
    expect((screen.getByLabelText('Draft campaign name 2') as HTMLInputElement).value).toBe(names['1']);
  });
});
describe('executor presentation boundary and resource results', () => {
  it('has no enabled Amazon-write control across any production presentation state', () => {
    let labelled = 0;
    for (const item of campaignVisualCases.filter((item) => !item.key.includes('executor-fixture'))) {
      const host = document.createElement('div'); host.innerHTML = renderToStaticMarkup(item.render());
      for (const control of host.querySelectorAll('button,a,input[type=submit]')) {
        if (!control.textContent?.includes('in Amazon')) continue;
        labelled++;
        expect(control.tagName, item.key).toBe('BUTTON');
        expect((control as HTMLButtonElement).disabled, item.key).toBe(true);
        expect(control.textContent).toMatch(/^Yes, (create \d+ campaigns?|retry \d+ keywords?) in Amazon$/);
        expect(host.textContent).toContain('Export bulk sheet');
      }
    }
    expect(labelled).toBe(2);
  });
  it('shows the exact disabled creation label, reason and export without recording approval', () => {
    render(<CreationConfirm review={fixtureReview} checks={validationChecks} executor={{ available: false }} onExport={noop} onBack={noop} />);
    const controls = screen.getAllByRole('button').filter((button) => button.textContent?.includes('in Amazon'));
    expect(controls).toHaveLength(1); expect(controls[0]?.textContent).toBe('Yes, create 1 campaign in Amazon'); expect((controls[0] as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Creation in Amazon is not available yet/)).toBeTruthy(); expect(screen.getByRole('button', { name: 'Export bulk sheet' })).toBeTruthy();
  });
  it('enables a registered fixture executor only with complete current checks', () => {
    const create = vi.fn(); const { rerender } = render(<CreationConfirm review={fixtureReview} checks={validationChecks} executor={{ available: true, create, retry: noop }} onExport={noop} onBack={noop} />);
    fireEvent.click(screen.getByRole('button', { name: 'Yes, create 1 campaign in Amazon' })); expect(create).toHaveBeenCalledOnce();
    rerender(<CreationConfirm review={fixtureReview} checks={[]} executor={{ available: true, create, retry: noop }} onExport={noop} onBack={noop} />);
    expect((screen.getByRole('button', { name: 'Yes, create 1 campaign in Amazon' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('renders only one unresolved keyword retry, separately disabled when the executor is absent', () => {
    render(<KeywordRetry result={creationResult(false)} executor={{ available: false }} onBack={noop} onExport={noop} />);
    expect((screen.getByRole('button', { name: 'Yes, retry 1 keyword in Amazon' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText('Reuse the created resource')).toHaveLength(3);
  });
  it('reconciles four original resources, one retry and no duplicated resources', () => {
    render(<CreationResult result={creationResult(true)} onBack={noop} onRetry={noop} />);
    expect(screen.getByText('Requested 4 · Attempted 4 · Succeeded 4 · Failed 0')).toBeTruthy();
    expect(screen.getByText('Retry: 1 keyword requested · 1 created · 0 duplicated resources')).toBeTruthy();
    expect(CampaignBuilderResult.safeParse({ ...creationResult(true), retry: { requested: 1, created: 2, duplicated: 0 } }).success).toBe(false);
    const partial = creationResult(false);
    expect(CampaignBuilderResult.safeParse({ ...partial, resources: partial.resources.map((row) => row.status === 'failed' ? { ...row, status: 'unknown' } : row) }).success).toBe(false);
  });
});
