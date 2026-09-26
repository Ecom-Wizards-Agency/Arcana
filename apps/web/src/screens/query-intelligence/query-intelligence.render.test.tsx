// @vitest-environment jsdom
import Loading from '../../../app/query-intelligence/loading';
import { verifyScreen } from '../render-test-support';
import SharedError from '../shared-error';
import { profile } from '../synthetic-render-fixtures';
import { descriptor } from './descriptor';
import { ready } from './render-fixture';
import Screen, { SQP_EXPLANATION, SQP_TITLE } from './view';
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';

verifyScreen(descriptor, [
  { state: 'loading', name: 'renders the route loading boundary', render: () => <Loading />, text: '' },
  { state: 'error', name: 'renders the shared error boundary with its reference', render: () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-reference' })} reset={() => { }} />, text: 'synthetic-reference' },
  { state: 'ready', name: 'renders the screen with synthetic data', render: () => <Screen data={ready} />, text: "Search query performance (SQP)" },
  { state: 'error', name: 'preserves the safe read error message', render: () => <Screen data={{ view: 'error', props: { message: 'Synthetic read unavailable' } }} />, text: 'Synthetic read unavailable' },
  { state: 'empty', name: 'shows an empty profile roster without invented data', render: () => <Screen data={{ view: 'empty', props: {} }} />, text: "profiles" },
  { state: 'not-measured', name: 'does not substitute measured results for absent evidence', render: () => <Screen data={{ view: 'not-measured', props: { profile } }} />, text: "No weekly SQP data yet" }
]);

describe('Search query performance title and connection state', () => {
  it('titles every state as SQP with one line on what the data is and where it comes from', () => {
    expect(SQP_TITLE).toBe('Search query performance (SQP)');
    expect(SQP_EXPLANATION).toBe('Amazon Brand Analytics search query performance, reported weekly for each marketplace. It arrives through the Seller Central connection.');
    expect(descriptor.guard.heading).toBe(SQP_TITLE);
    expect(descriptor.nav.label).toBe('Queries');
    expect(descriptor.path).toBe('/queries');
    const states = [ready, { view: 'empty', props: {} }, { view: 'error', props: { message: 'Synthetic read unavailable' } }, { view: 'not-measured', props: { profile } }] as const;
    for (const data of states) {
      const { unmount } = render(<Screen data={data} />);
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(SQP_TITLE);
      const explanation = screen.getByTestId('sqp-explanation');
      expect(explanation.textContent).toBe(SQP_EXPLANATION);
      expect(screen.getByRole('heading', { level: 1 }).nextElementSibling).toBe(explanation);
      expect(document.querySelector('main > header')!.textContent).not.toContain('Query Intelligence');
      unmount();
    }
    expect(states).toHaveLength(4);
  });
  it('leads the no-data state with what is missing and the next step, before any evidence panel', () => {
    render(<Screen data={{ view: 'not-measured', props: { profile } }} />);
    const state = document.querySelector<HTMLElement>('[data-state="not-measured"]')!;
    expect(state.querySelector('.wa-empty__title')!.textContent).toBe('No weekly SQP data yet');
    expect(state.querySelector('.wa-empty__body')!.textContent!.trim()).toBe("Next step: connect Seller Central in Settings → Connections. Once it is connected, Amazon's weekly search query performance report arrives on its own, and this page fills in once the first full week (Sunday to Saturday) is in.");
    expect(within(state).getByRole('link', { name: 'Connect Seller Central' }).getAttribute('href')).toBe('/settings/connections');
    expect(state.textContent).not.toMatch(/contract|worker|promote/i);
    const evidence = screen.getByRole('region', { name: 'Amazon provider evidence' });
    expect(state.compareDocumentPosition(evidence) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector('main')!.firstElementChild!.tagName).toBe('HEADER');
  });
  it('keeps the vocabulary workbench below the no-data state when the loader supplies it', () => {
    const research = { marketplaceId: ready.props.scope.marketplaceId, weekStart: ready.props.scope.weekStart, category: null, search: '', model: ready.props.model };
    render(<Screen data={{ view: 'not-measured', props: { profile, research } }} />);
    const state = document.querySelector<HTMLElement>('[data-state="not-measured"]')!;
    const vocabulary = screen.getByRole('region', { name: 'Query vocabulary' });
    expect(state.compareDocumentPosition(vocabulary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Demand split' }).textContent).toContain('Not measured');
    expect(screen.queryByRole('form', { name: 'Query intelligence filters' })).toBeNull();
  });
});
