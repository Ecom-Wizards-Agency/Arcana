import { catalogueEvidenceFixtures } from '../grid/catalogue-fixtures';
// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { serializeGridView } from '@wizard-ads/shared';
import { rendered, verifyScreen } from '../render-test-support';
import { descriptor } from './descriptor';
import Screen from './view';
import Loading from '../../../app/targets/[id]/loading';
import SharedError from '../shared-error';

import { fireEvent, render, screen } from '@testing-library/react';
import { targetFixture } from './fixtures';
const ready = { ...targetFixture, view: 'ready' as const, currencyCode: 'USD', back: '/grid?entity=targets&view=1.synthetic', savedView: null };
verifyScreen(descriptor, [
  { state: 'loading', name: 'renders loading', render: () => <Loading />, text: '' },
  { state: 'error', name: 'renders errors', render: () => <SharedError error={new Error('Synthetic error')} reset={() => {}} />, text: '' },
  { state: 'gated', name: 'renders the agency gate', render: () => <Screen data={{ view: 'gated', state: 'no-database' }} />, text: 'database' },
  { state: 'ready', name: 'renders the synthetic keyword', render: () => <Screen data={ready} />, text: 'Synthetic keyword' },
  { state: 'empty', name: 'renders an empty rank series', render: () => <Screen data={{ ...ready, ranks: [] }} />, text: '0 observations' },
  { state: 'not-measured', name: 'renders unmeasured ranks', render: () => <Screen data={{ ...ready, ranks: [{ ...ready.ranks[0]!, organicRank: null }] }} />, text: 'Not measured' },
]);
it('renders corridor, spend, ACOS, all rank rows and the exact return URL', () => {
  const host = rendered(<Screen data={ready} />);
  expect(host.querySelector('[aria-label="Bid corridor chart"]')).not.toBeNull();
  expect(host.textContent).toContain('spend'); expect(host.textContent).toContain('ACOS');
  expect(host.textContent).toContain('20.0%');
  const renderedScreen = render(<Screen data={ready} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Rank' }));
  expect(renderedScreen.container.querySelectorAll('[aria-label="Rank observations"] tbody tr')).toHaveLength(ready.ranks.length);
  expect(host.querySelector('a')?.getAttribute('href')).toBe(ready.back);
});

it('renders each data tab, shelf gap and all fact/change rows', () => {
  const host = render(<Screen data={ready} />);
  fireEvent.click(screen.getByRole('tab',{name:'Changes'}));
  expect(host.container.querySelectorAll('tbody tr')).toHaveLength(ready.changes.length);
  fireEvent.click(screen.getByRole('tab',{name:'Performance'}));
  expect(host.container.querySelectorAll('tbody tr')).toHaveLength(ready.performance.length);
  fireEvent.click(screen.getByRole('tab',{name:'Shelf'}));
  expect(host.container.textContent).toContain('Product evidence is missing');
  expect(host.container.textContent).toContain('does not establish asset moderation approval');
});
it('blocks a protected decrease until an override reason is recorded', () => {
  render(<Screen data={ready} />);
  fireEvent.change(screen.getByLabelText('Proposed bid'),{target:{value:'4'}});
  expect(screen.getByRole('button',{name:'Add to change queue'}).hasAttribute('disabled')).toBe(true);
  fireEvent.change(screen.getByLabelText('Override reason'),{target:{value:'Synthetic reviewed rank override'}});
  expect(screen.getByRole('button',{name:'Add to change queue'}).hasAttribute('disabled')).toBe(false);
});
it('preserves URL state when toggling', () => {
  window.history.replaceState(null,'','/targets/synthetic');
  render(<Screen data={ready} />);
  fireEvent.click(screen.getByLabelText('Realised CPC'));
  expect(new URL(window.location.href).searchParams.get('view')).toMatch(/^1\./);
});
it('renders the empty-series honesty note without invented values', () => {
  const host = rendered(<Screen data={{...ready,payload:{...ready.payload,points:[]},performance:[],bidContext:null}} />);
  expect(host.textContent).toContain('No reference values or invented numbers');
  expect(host.textContent).toContain('Target ACOS setting is missing');
});
it('refuses the fifth target without changing the persisted four', () => {
  const saved = { id:'compare',name:'Synthetic compare',entity:'targets' as const,columns:[],pinned:[],widths:{},filter:{groups:[]},sort:[],groupBy:[],dateRange:null,updatedAt:'2026-08-13',compare:Array.from({length:4},(_,i)=>({profileId:ready.profileId,targetId:`other-${i}`})) };
  const host = render(<Screen data={{...ready,savedView:serializeGridView(saved)}} />);
  fireEvent.click(screen.getByRole('button',{name:'Add to compare'}));
  expect(host.container.textContent).toContain('Compare holds up to four targets');
  expect(host.container.querySelectorAll('[aria-label="Compare targets"] > section')).toHaveLength(4);
});
it('renders measured target top-of-search share and retains the SQP gap', () => {
  const host = rendered(<Screen data={{...ready,performance:[{...ready.performance[0]!,topOfSearchShare:0.14}]}} />);
  expect(host.textContent).toContain('T · 14.0%');
  expect(host.textContent).toContain('I · P not measured');
  expect(host.textContent).not.toContain('Top-of-search share: column empty.');
});

it('renders authoritative zero-uplift CPC separately from missing placement evidence', () => {
  const point = { ...ready.payload.points[0]!, bid: 5, maxCpc: 5, components: [], placementEvidence: 'known-zero' as const };
  const view = render(<Screen data={{ ...ready, payload: { ...ready.payload, points: [point] } }} />);
  expect(view.container.textContent).toContain('Placement uplifts: 0%.');
  expect(view.container.textContent).toContain('$5.00 base × (1 + 0% placement uplift)');
  view.rerender(<Screen data={{ ...ready, payload: { ...ready.payload, points: [{ ...point, storedMaxCpc: 5, maxCpc: null, placementEvidence: 'missing' }] } }} />);
  expect(view.container.textContent).toContain('Placement modifiers not measured.');
  expect(view.container.textContent).toContain('Placement formula not measured.');
  const maxCpc = Array.from(view.container.querySelectorAll('dt')).find((node) => node.textContent === 'Max CPC');
  expect(maxCpc?.nextElementSibling?.textContent).toContain('Not measured');
  expect(view.container.textContent).not.toContain('Placement uplifts: 0%.');
});

it('renders nine scoped Shelf evidence rows including refusal, stale verdicts and SKU ambiguity',()=>{
  const products=catalogueEvidenceFixtures();
  const host=render(<Screen data={{...ready,shelf:products}}/>);
  fireEvent.click(screen.getByRole('tab',{name:'Shelf'}));
  const rows=host.container.querySelectorAll('[aria-label="Product evidence"] tbody tr');
  expect(rows).toHaveLength(9);
  expect([...rows].map(row=>row.children[2]?.textContent)).toEqual(['missing','missing','partial','partial','measured','measured','stale','stale','partial']);
  expect(rows[7]!.textContent).toContain('Unavailable (stale)');expect(rows[8]!.textContent).toContain('Ambiguous SKU evidence');
  expect(rows[8]!.textContent).toContain('sku-a');expect(rows[8]!.textContent).toContain('sku-b');
  expect(rows[5]!.textContent).toContain('Measured product reason 5');
  expect(host.container.textContent).toContain('does not establish asset moderation approval');
});
