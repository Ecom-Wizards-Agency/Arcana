// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Builder } from './builder';
import { campaignVisualCases } from './visual-cases';
import { builderContext, builderRecipe, validatedDraft, blockedDraft, fixtureReview, validationChecks, assetSnapshot, creationResult } from './render-fixture';
import { DraftReady } from '../campaigns-draft/view';
import { CreationConfirm, CreationResult, KeywordRetry } from '../campaigns-draft/creation-states';
import { BidEditor } from '../campaigns-draft/bid';
import { AssetPicker } from '../campaigns-assets/picker';

const noop = () => {};
describe('page 12 design review corrections', () => {
  it('shows complete play guidance and groups the live counts with the sentence control', () => {
    render(<Builder context={builderContext} initialRecipe={builderRecipe} initialStep="targets" />);
    expect(screen.getByText(/Four words your account already speaks/)).toBeTruthy();
    for (const text of [/ACOS is not a cut criterion/, /Phrase or Auto/, /Halo exact group/, /self-target PAT/]) expect(screen.getByText(text)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Rank Buy velocity/ }).getAttribute('aria-pressed')).toBe('true');
    const grouping = screen.getByLabelText('Campaign structure').parentElement!;
    expect(grouping.textContent).toContain('1 keyword × 1 product = 1 campaign, 1 keyword each');
    expect(screen.getByText('Save these keywords as a set').parentElement?.hasAttribute('open')).toBe(false);
  });
  it('shows the recorded name result and exposure ceiling even if current strategy changes', () => {
    render(<DraftReady data={{ view: 'ready', context: { ...builderContext, exposureCeiling: 12 }, draft: validatedDraft, review: fixtureReview, executorAvailable: false, step: 'review' }} />);
    expect(screen.getByText('Distinct name confirmed')).toBeTruthy();
    expect(screen.getByText(/\$0\.36 × 2\.4 = \$0\.864 → \$0\.86 rounded/)).toBeTruthy();
    expect(screen.getByText('Within $2.40 hard ceiling · Passed')).toBeTruthy();
    expect(screen.queryByText(/Within \$12/)).toBeNull();
  });
  it('shows the exact saved invalid budget and required minimum with continuation disabled', () => {
    render(<DraftReady data={{ view: 'ready', context: builderContext, draft: blockedDraft, review: fixtureReview, executorAvailable: false, step: 'validation' }} />);
    expect(screen.getByText('Daily budget is below the marketplace minimum')).toBeTruthy();
    expect(screen.getByRole('cell', { name: '$0.30' })).toBeTruthy();
    const check = blockedDraft.validation!.checks.find((item) => item.id === 'budget')!;
    expect(screen.getByText(check.requiredAction)).toBeTruthy();
    expect(check.requiredAction).toContain('at least');
    expect((screen.getByRole('button', { name: 'Continue to confirmation' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('updates the edit summary before save without implying that edits have passed validation', () => {
    render(<DraftReady data={{ view: 'ready', context: builderContext, draft: validatedDraft, review: fixtureReview, executorAvailable: false, step: 'review' }} initiallyEditing />);
    fireEvent.change(screen.getByLabelText('Draft bid 1'), { target: { value: '0.48' } });
    fireEvent.change(screen.getByLabelText('Draft top-of-search adjustment'), { target: { value: '160' } });
    const summary = screen.getByLabelText('Edited values summary');
    expect(summary.textContent).toContain('$0.48 × 2.6 = $1.248');
    expect(summary.textContent).toContain('Saving revalidates the exact edited draft');
    expect(summary.textContent).not.toContain('Passed');
  });
  it('puts the bid editor ahead of expanded details, labels selected and suggested bids and exposes input errors', () => {
    render(<BidEditor keyword={builderRecipe.keywords[0]!} evidence={builderContext.bidEvidence[0]!} bounds={{ floor: 0.12, ceiling: 0.96, exposureCeiling: 2.4, decimalPlaces: 2 }} currency="USD" topOfSearch={700} audienceAdjustment={0} expanded onUse={noop} onCancel={noop} />);
    const amount = screen.getByLabelText('Starting bid amount');
    expect(amount.getAttribute('aria-invalid')).toBe('true');
    expect(amount.compareDocumentPosition(screen.getByRole('table')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('· CPC suggestion')).toBeTruthy();
    expect(screen.getByText('· Selected starting bid')).toBeTruthy();
    expect(screen.getByText('The bid, and why').parentElement?.hasAttribute('open')).toBe(false);
  });
  it.each([false, true])('keeps the no-delete-rollback disclosure with executor availability %s', (available) => {
    render(<CreationConfirm review={fixtureReview} marketplaceLabel="US" checks={validationChecks} executor={available ? { available: true, create: noop, retry: noop } : { available: false }} onExport={noop} onBack={noop} />);
    expect(screen.getByText('Created resources cannot be deleted through rollback.')).toBeTruthy();
    expect(screen.getByText('Pausing or archiving them requires a separate reviewed action.')).toBeTruthy();
    expect(screen.getByText(/US · USD · Campaign starts paused/)).toBeTruthy();
  });
  it.each(['library', 'used'] as const)('keeps unknown thumbnail and duration inside each %s creative card', (tab) => {
    render(<AssetPicker snapshot={assetSnapshot} used={[{ id: 'synthetic-creative', amazonAssetId: 'synthetic-asset', name: 'Synthetic mirrored creative', kind: 'sb_video', usedInCampaignIds: ['synthetic-campaign'] }]} canRefresh onRefresh={async () => {}} initialTab={tab} />);
    const cards = screen.getAllByRole('article'); expect(cards).toHaveLength(1);
    expect(within(cards[0]!).getByText('Thumbnail unavailable')).toBeTruthy();
    expect(within(cards[0]!).getByText('Duration not measured · Used in 1 campaign')).toBeTruthy();
    expect(screen.getByText(/Observed: 10 Jun 2026, 12:00 UTC/)).toBeTruthy();
  });
  it.each(campaignVisualCases.filter((item) => ['empty', 'gated', 'not-measured'].includes(item.key)))('$screen $key identifies the missing source or permission and supplies a next action', (item) => {
    const { container } = render(item.render());
    expect(container.textContent).not.toMatch(/Campaign screen (empty|gated|not-measured)/);
    expect(screen.getAllByRole('link').some((link) => ['/campaigns', '/settings/connections', '/settings/members'].includes(link.getAttribute('href') ?? ''))).toBe(true);
    if (item.screen === 'campaigns-eligibility') {
      expect(screen.getAllByText('not measured')).toHaveLength(9);
      expect(screen.queryByText(/The four checks marked not measured/)).toBeNull();
    }
  });
  it('names the failed keyword and keeps retry accounting explicit', () => {
    const { rerender } = render(<CreationResult result={creationResult(false)} onRetry={noop} onBack={noop} />);
    expect(screen.getByText('The campaign is paused. The keyword failed.')).toBeTruthy();
    rerender(<KeywordRetry plan={fixtureReview.plan} result={creationResult(false)} executor={{ available: false }} onBack={noop} />);
    expect(screen.getByText('Campaign paused · 3 resources already created')).toBeTruthy();
    rerender(<CreationResult result={creationResult(true)} onRetry={noop} onBack={noop} />);
    expect(screen.getByText('The keyword retry succeeded. The campaign remains paused while you review it.')).toBeTruthy();
    expect(screen.getByText('Resource details').parentElement?.hasAttribute('open')).toBe(false);
  });
});
