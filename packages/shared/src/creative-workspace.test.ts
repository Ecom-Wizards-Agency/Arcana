import { describe, expect, it } from 'vitest';
import { CreativeChangeCertainty, CreativeWorkspace, CreativeWorkspaceCampaign, creativeProductUrl } from './creative.js';

describe('creative workspace contracts', () => {
  it('represents an unmeasured workspace without inventing policy or metrics', () => {
    const workspace = CreativeWorkspace.parse({ assets: [], campaigns: [], placements: [], changes: [], listingChanges: [], history: [], events: [], minClicks: null, targetAcos: null });
    expect(workspace.minClicks).toBeNull();
    expect(workspace.targetAcos).toBeNull();
  });
  it('refuses an unresolved row carrying a guessed keyword', () => {
    expect(CreativeWorkspaceCampaign.safeParse({ campaignId: 'synthetic-campaign', name: null,
      keywordText: 'guessed', keywordProvenance: 'unresolved', keywordCount: null, adGroups: [],
      modifiers: { topOfSearch: null, restOfSearch: null, productPages: null } }).success).toBe(false);
  });
  it('refuses an exact certainty without an observation bracket', () => {
    expect(CreativeChangeCertainty.safeParse({ kind: 'exact', from: null, to: '2026-06-02T12:00:00.000Z', widthDays: null }).success).toBe(false);
    expect(CreativeChangeCertainty.safeParse({ kind: 'exact', from: '2026-06-01T12:00:00.000Z', to: '2026-06-05T12:00:00.000Z', widthDays: 4 }).success).toBe(false);
  });
  it('builds an isolated product link from a supported marketplace and valid ASIN', () => {
    const url = new URL(creativeProductUrl('DE', 'B000000011')!);
    expect(url.hostname).toBe('www.amazon.de');
    expect(url.pathname).toBe('/dp/B000000011');
    expect(url.search).toBe('');
    expect(url.username).toBe('');
    for (const asin of [null, 'bad/../../link', 'B000000011?token=x']) expect(creativeProductUrl('DE', asin)).toBeNull();
    expect(creativeProductUrl('unknown', 'B000000011')).toBeNull();
  });
});
