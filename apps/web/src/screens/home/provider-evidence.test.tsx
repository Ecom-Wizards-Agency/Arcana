// @vitest-environment jsdom
import { expect, it } from 'vitest';
import type { ProviderEvidenceReadResult } from '@wizard-ads/shared';
import { rendered } from '../render-test-support';
import { row } from '../recommendations/provider-evidence.fixture';
import { HomeContent } from './view';
import { withoutBudget } from './fixtures';

it.each(['not-measured','measured','stale','expired'] as const)('renders %s provider evidence through Home', (state) => {
  const now = new Date().toISOString();
  const observedAt = state === 'stale' ? '2020-01-01T00:00:00.000Z' : now;
  const evidence: ProviderEvidenceReadResult = {
    rows: state === 'not-measured' ? [] : [{ ...row, observedAt, generatedAt: observedAt, retrievedAt: now, expiresAt: state === 'expired' ? '2020-01-01T00:00:00.000Z' : null }],
    runs: [], totalCount: state === 'not-measured' ? 0 : 1,
  };
  const host = rendered(<HomeContent {...withoutBudget} home={{ ...withoutBudget.home, providerEvidence: evidence }} />);
  const panel = host.querySelector('[aria-label="Amazon provider evidence"]');
  expect(panel).not.toBeNull(); expect(panel!.textContent).toContain(state);
  expect(panel!.querySelectorAll('[data-provider-evidence-row]')).toHaveLength(evidence.totalCount);
  expect(panel!.querySelectorAll('button')).toHaveLength(0);
  if (evidence.totalCount) expect(panel!.textContent).toContain('Amazon estimate');
});
