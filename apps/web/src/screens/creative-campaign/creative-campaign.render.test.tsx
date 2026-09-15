// @vitest-environment jsdom
import { verifyScreen } from '../render-test-support';
import Loading from '../shared-loading';
import SharedError from '../shared-error';
import { visualFixture } from '../creative/render-fixture';
import Screen from './view';
import { descriptor } from './descriptor';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
verifyScreen(descriptor, [
  { state: 'loading', name: 'renders pending evidence', render: () => <Loading />, text: '' },
  { state: 'error', name: 'renders a safe read failure', render: () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-reference' })} reset={() => {}} />, text: 'synthetic-reference' },
  { state: 'gated', name: 'keeps the membership gate explicit', render: () => <Screen data={visualFixture('membership-gated')} />, text: 'database' },
  { state: 'empty', name: 'keeps the absent profile roster explicit', render: () => <Screen data={visualFixture('no-profiles')} />, text: 'No profiles yet' },
  { state: 'not-measured', name: 'renders missing source evidence', render: () => <Screen data={visualFixture('floor-unmeasured')} />, text: 'not yet measured' },
  { state: 'ready', name: 'renders its complete synthetic state', render: () => <Screen data={visualFixture('campaign-clean')} />, text: 'Creative test — synthetic comparison phraseSynthetic comparison campaign · 1 Aug 2026 – 29 Aug 2026' },
]);

describe('Creative test evidence', () => {
  it('shows the clean one-keyword comparison with every creative counted', () => {
    render(<Screen data={visualFixture('campaign-clean')} />);
    expect(screen.getByRole('heading', { name: /clean · 1 keyword · 2 ad groups · 2 creatives/ })).toBeTruthy();
    expect(screen.getAllByTestId('creative-test-row')).toHaveLength(2);
  });
  it('names drift and retains all three resulting rows', () => {
    render(<Screen data={visualFixture('campaign-drifted')} />);
    expect(screen.getByRole('heading', { name: /drifted · 2 keywords/ })).toBeTruthy();
    expect(screen.getAllByTestId('creative-test-row')).toHaveLength(3);
    expect(screen.getByText('No winner is declared while the evidence is unmeasured.')).toBeTruthy();
  });
  it('keeps a thin creative visible with unmeasured CTR and CVR', () => {
    render(<Screen data={visualFixture('campaign-thin')} />);
    const rows = screen.getAllByTestId('creative-test-row');
    expect(rows).toHaveLength(2);
    const thin = rows.find((row) => row.getAttribute('data-thin') === 'true');
    expect(thin).toBeTruthy();
    expect(within(thin!).getAllByLabelText(/Below the account click threshold/)).toHaveLength(2);
  });
  it('distinguishes CVR when its spread exceeds this account’s floor', () => {
    render(<Screen data={visualFixture('verdict-cvr')} />);
    expect(screen.getByRole('heading', { name: 'CVR separates these creatives. CTR does not separate these creatives.' })).toBeTruthy();
  });
  it('distinguishes CTR when only that spread exceeds the account floor', () => {
    render(<Screen data={visualFixture('verdict-ctr')} />);
    expect(screen.getByRole('heading', { name: 'CVR does not separate these creatives. CTR separates these creatives.' })).toBeTruthy();
  });
  it('declares no winner before the noise floor is measured', () => {
    render(<Screen data={visualFixture('floor-unmeasured')} />);
    expect(screen.getByRole('heading', { name: 'The account’s noise floor is not yet measured' })).toBeTruthy();
    expect(screen.getByText('No winner is declared while the evidence is unmeasured.')).toBeTruthy();
  });
});
