// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CAMPAIGN_AD_TYPE_SNAPSHOT } from '@wizard-ads/shared';
import { AssetPicker } from '../campaigns-assets/picker';
import { BidEditor } from '../campaigns-draft/bid';
import DraftScreen from '../campaigns-draft/view';
import { KeywordRetry } from '../campaigns-draft/creation-states';
import { Builder } from './builder';
import { DRAFTING_UNAVAILABLE } from './products';
import { assetSnapshot, builderContext, builderRecipe, creationResult, fixtureCpcRationale, fixtureId, fixtureReview } from './render-fixture';

const noop = () => {};
const used = { id: 'synthetic-mirror', amazonAssetId: 'synthetic-asset', name: 'Synthetic mirrored creative', kind: 'sb_video', usedInCampaignIds: ['synthetic-campaign'] };
const usable = { ...assetSnapshot.assets[0]!, thumbnailUrl: 'https://example.invalid/synthetic-thumbnail.png', thumbnailExpiresAt: '2099-01-01T00:00:00Z' };

describe('round 3 review findings', () => {
  it.each(['SP', 'SB', 'SBV', 'SD'] as const)('keeps verified rows and separates %s drafting availability', (adType) => {
    render(<Builder context={builderContext} initialRecipe={{ ...builderRecipe, adType }} />);
    for (const entry of CAMPAIGN_AD_TYPE_SNAPSHOT.entries) {
      const card = screen.getByRole('button', { name: new RegExp(`^${entry.name} ${entry.adType} ·`) });
      for (const row of entry.rows) expect(card.textContent).toContain(`${row.supported ? '✓' : '—'} ${row.label}`);
      expect(card.textContent?.includes(DRAFTING_UNAVAILABLE)).toBe(entry.adType !== 'SP');
    }
    expect(screen.getAllByText(DRAFTING_UNAVAILABLE)).toHaveLength(3);
    expect(screen.queryByText(/unavailable in the capability snapshot/)).toBeNull();
    if (adType !== 'SP') {
      expect(screen.getAllByRole('status').filter((notice) => notice.textContent?.includes(DRAFTING_UNAVAILABLE))).toHaveLength(1);
      expect((screen.getByRole('button', { name: 'Save campaign draft' }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(screen.getByText(/Snapshot 15 Sept? 2026 · Version v1/)).toBeTruthy();
  });

  it('reuses a resolved video observation with the original asset identity and version', () => {
    const select = vi.fn(); const refresh = vi.fn();
    render(<AssetPicker snapshot={{ ...assetSnapshot, assets: [usable] }} used={[used]} canRefresh onRefresh={refresh} onSelect={select} initialTab="used" />);
    const card = screen.getByRole('article');
    fireEvent.click(within(card).getByRole('button', { name: 'Reuse asset' }));
    expect(select).toHaveBeenCalledExactlyOnceWith(usable);
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByText(/Selected for review: synthetic-asset · version 1/)).toBeTruthy();
  });

  it.each([
    ['no observation', [], used, 'No asset observation.'],
    ['unsupported creative', [usable], { ...used, kind: 'image' }, 'Unsupported creative kind.'],
    ['unsupported observation', [{ ...usable, observation: { ...usable.observation, assetType: 'image' } }], used, 'Unsupported asset kind.'],
    ['inactive processing', [{ ...usable, observation: { ...usable.observation, processing: 'inactive' } }], used, 'Asset processing is not active.'],
    ['missing thumbnail', assetSnapshot.assets, used, 'Thumbnail unavailable.'],
    ['expired thumbnail', [{ ...usable, thumbnailExpiresAt: '2000-01-01T00:00:00Z' }], used, 'Expired thumbnail.'],
    ['ambiguous version', [usable, { ...usable, observation: { ...usable.observation, identity: { ...usable.observation.identity, version: '2' } } }], used, 'Multiple asset versions match.'],
  ] as const)('disables reuse for %s and preserves the reason inside the card', (_, assets, creative, reason) => {
    const select = vi.fn();
    render(<AssetPicker snapshot={{ ...assetSnapshot, assets: [...assets] }} used={[creative]} canRefresh={false} onRefresh={async () => {}} onSelect={select} initialTab="used" />);
    fireEvent.click(screen.getByRole('button', { name: 'All assets' }));
    const card = screen.getByRole('article');
    const button = within(card).getByRole('button', { name: 'Reuse asset' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(card.textContent).toContain(reason);
    expect(button.getAttribute('aria-describedby')).toBeTruthy();
    fireEvent.click(button); expect(select).not.toHaveBeenCalled();
  });

  it.each([false, true])('preserves keyword-only retry scope with executor %s', (available) => {
    render(<KeywordRetry plan={fixtureReview.plan} result={creationResult(false)} executor={available ? { available: true, create: noop, retry: noop } : { available: false }} onBack={noop} />);
    expect(screen.getByText('Unresolved keyword: “synthetic lantern”.')).toBeTruthy();
    expect(screen.getByText(/Keyword-only export is not available/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Export bulk sheet' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/Export the bulk sheet to create these campaigns/)).toBeNull();
    expect((screen.getByRole('button', { name: 'Yes, retry 1 keyword in Amazon' }) as HTMLButtonElement).disabled).toBe(!available);
  });

  it('refuses retry when the unresolved resource cannot be named from the reviewed plan', () => {
    const result = creationResult(false);
    const unmatched = { ...result, resources: result.resources.map((row) => row.kind === 'keyword' ? { ...row, nodeId: fixtureId(999) } : row) };
    render(<KeywordRetry plan={fixtureReview.plan} result={unmatched} executor={{ available: true, create: noop, retry: noop }} onBack={noop} />);
    expect(screen.getByText(/Keyword name unavailable/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Yes, retry 1 keyword in Amazon' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each(['manual', 'keyword_cpc', 'sqp_value'] as const)('opens the frozen rationale and all evidence from %s, then returns to editing', async (basis) => {
    render(<BidEditor keyword={{ ...builderRecipe.keywords[0]!, basis }} evidence={builderContext.bidEvidence[0]!} bounds={{ floor: 0.12, ceiling: 0.96, exposureCeiling: 2.4, decimalPlaces: 2 }} currency="USD" topOfSearch={140} audienceAdjustment={0} frozenRationale={fixtureCpcRationale} onUse={noop} onCancel={noop} />);
    fireEvent.click(screen.getByText('The bid, and why'));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'The bid, and why' })).toBeTruthy());
    const evidence = screen.getByLabelText('Bid evidence');
    for (const value of ['160 clicks', '$96.00 spend', '30 days', 'ACOS: 30%', 'SQP: no data']) expect(evidence.textContent).toContain(value);
    expect(screen.getByText(`“${fixtureCpcRationale}”`)).toBeTruthy();
    expect(screen.getByText(/1 – 30 May 2026/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Use this bid' })).toBeNull();
    fireEvent.click(screen.getByText('Return to starting bid'));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Set starting bid' })).toBeTruthy());
    expect(screen.getByLabelText('Starting bid amount')).toBeTruthy();
  });

  it('does not relabel a spend-derived CPC as a reported measurement', () => {
    render(<BidEditor keyword={builderRecipe.keywords[0]!} evidence={{ ...builderContext.bidEvidence[0]!, reportedCpc: null }} bounds={{ floor: 0.12, ceiling: 0.96, exposureCeiling: 2.4, decimalPlaces: 2 }} currency="USD" topOfSearch={140} audienceAdjustment={0} expanded onUse={noop} onCancel={noop} />);
    const reported = screen.getByRole('row', { name: /^Reported keyword CPC/ });
    expect(reported.textContent).toContain('Not measured');
    expect(screen.getByRole('row', { name: /^Base bid formula/ }).textContent).toContain('$0.60 ÷ 2.4');
  });

  it('renders one recovery action for unavailable draft evidence', () => {
    render(<DraftScreen data={{ view: 'not-measured', message: '' }} />);
    expect(screen.getAllByRole('link', { name: 'Return to builder' })).toHaveLength(1);
  });
});
