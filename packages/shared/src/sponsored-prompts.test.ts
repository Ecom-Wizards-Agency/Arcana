import { describe, expect, it } from 'vitest';
import { normalizeSponsoredPrompt, SponsoredPromptImport, sponsoredPromptConsoleUrl } from './sponsored-prompts.js';
const row = { adProduct: 'SB', campaignId: 'synthetic-campaign', adGroupId: 'synthetic-group', promptText: 'Synthetic prompt',
  observedAt: '2026-06-02T00:00:00Z', status: 'live', intervalStart: '2026-06-01T00:00:00Z', intervalEnd: '2026-06-02T00:00:00Z', spend: 7, clicks: 4, sales: null, orders: null };
const input = { profileId: '00000000-0000-4000-8000-000000000001', metricSemantics: 'disjoint_interval_deltas', rows: [row] };
describe('sponsored prompt import contract', () => {
  it('requires explicit disjoint deltas, preserves missing metrics and bounds rows', () => {
    expect(SponsoredPromptImport.parse(input).rows[0]?.sales).toBeNull();
    expect(SponsoredPromptImport.safeParse({ ...input, metricSemantics: 'cumulative' }).success).toBe(false);
    expect(SponsoredPromptImport.safeParse({ ...input, rows: Array.from({ length: 1001 }, () => row) }).success).toBe(false);
    expect(SponsoredPromptImport.safeParse({ ...input, rows: [{ ...row, intervalEnd: row.intervalStart }] }).success).toBe(false);
    expect(SponsoredPromptImport.safeParse({ ...input, userId: 'forged' }).success).toBe(false);
  });
  it('normalizes spacing and case without guessing text', () => {
    expect(normalizeSponsoredPrompt('  Synthetic\n  PROMPT ')).toBe('synthetic prompt');
  });
  it('contains only the marketplace, ad product and campaign in console links', () => {
    const url = new URL(sponsoredPromptConsoleUrl('DE', 'SB', 'synthetic-campaign')!);
    expect(url.hostname).toBe('advertising.amazon.de');
    expect(url.pathname).toBe('/cm/sb/campaigns/synthetic-campaign/ad-groups');
    expect(url.search).toBe(''); expect(url.hash).toBe(''); expect(url.username).toBe(''); expect(url.password).toBe('');
    expect(sponsoredPromptConsoleUrl('US', 'SP', 'synthetic-campaign')).toContain('/cm/sp/');
    expect(sponsoredPromptConsoleUrl('XX', 'SP', 'synthetic-campaign')).toBeNull();
    expect(sponsoredPromptConsoleUrl('US', 'SP', 'bad?profile=foreign')).toBeNull();
  });
});
