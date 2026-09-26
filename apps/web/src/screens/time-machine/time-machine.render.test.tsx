import { amazonEntryFixtures } from '../grid/catalogue-fixtures';
// @vitest-environment jsdom
import { COORDINATED_RESTORE_UNAVAILABLE, type ChangeQueueEntry } from '@wizard-ads/shared';
import { expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import Loading from '../../../app/time-machine/loading';
import { verifyScreen } from '../render-test-support';
import SharedError from '../shared-error';
import { descriptor } from './descriptor';
import { ready, restore } from './render-fixture';
import Screen from './view';
vi.mock('next/navigation',()=>({useRouter:()=>({push:vi.fn(),refresh:vi.fn()})}));
verifyScreen(descriptor, [
  { state:'loading', name:'renders the route loading boundary',render:()=> <Loading/>,text:'' },
  { state:'error',name:'renders the shared error boundary with its reference',render:()=> <SharedError error={Object.assign(new Error('Synthetic failure'),{digest:'synthetic-reference'})} reset={()=>{}}/>,text:'synthetic-reference' },
  { state:'ready',name:'renders the screen with synthetic data',render:()=> <Screen data={ready}/>,text:'Every change we can see' },
  { state:'error',name:'preserves the safe read error message',render:()=> <Screen data={{view:'error',props:{message:'Synthetic read unavailable'}}}/>,text:'Synthetic read unavailable' },
  { state:'empty',name:'shows an empty profile roster without invented data',render:()=> <Screen data={{view:'empty',props:{}}}/>,text:'No changes recorded in this range' },
  { state:'not-measured',name:'reports exports awaiting a current mirror read',render:()=> <Screen data={{view:'ready',props:{...ready.props,partial:true}}}/>,text:'The mirror has not been read since the last export' },
  { state:'stale',name:'shows restore rows with conflicting current values',render:()=> <Screen data={restore}/>,text:'Someone changed it after us' },
  { state:'refused',name:'names unsupported restore rows',render:()=> <Screen data={restore}/>,text:'No adapter for this field' },
]);
it('renders all six source and attribution cases in newest-first order',()=>{
  render(<Screen data={ready}/>);
  const rows=screen.getAllByTestId('timeline-entry'); expect(rows).toHaveLength(6);
  expect(rows.map(row=>row.textContent)).toEqual([
    expect.stringContaining('Batch 1000 · 7 changes'),expect.stringContaining('not ours'),
    expect.stringContaining('Batch 1002 · two rows could explain it'),expect.stringContaining('Batch 1003 · experiment start'),
    expect.stringContaining('awaiting review'),expect.stringContaining('approved'),
  ]);
  expect(screen.getAllByRole('columnheader')).toHaveLength(8);
});
it.each(['awaiting review', 'admitted', 'attempted', 'succeeded', 'failed', 'observed'] as const)('renders the Restore queue source and its %s lifecycle state', (state) => {
  const entry = { ...ready.props.entries[0]!, source: 'restore' as const, state, reviewHref: '/optimizer/run/synthetic?plan=synthetic' };
  render(<Screen data={{ view: 'ready', props: { ...ready.props, entries: [entry] } }} />);
  const row = screen.getByTestId('timeline-entry');
  expect(screen.getAllByTestId('timeline-entry')).toHaveLength(1);
  expect(screen.getByTestId('entry-source').textContent).toBe('Restore');
  expect(row.textContent).toContain(state);
  if (state === 'awaiting review') expect(row.textContent).toContain('Review proposal');
  else expect(row.textContent).toContain('Batch 1000 · 7 changes');
});
it('renders exactly seven restore rows, ready 2, blocked 4 and nothing to do 1',()=>{
  const {container}=render(<Screen data={restore}/>);
  expect(screen.getAllByTestId('reversion-row')).toHaveLength(7);
  expect(container.querySelectorAll('[data-state="ready"]')).toHaveLength(2);
  expect(container.querySelectorAll('[data-state="conflict"]')).toHaveLength(2);
  expect(container.querySelectorAll('[data-state="unsupported"]')).toHaveLength(1);
  expect(container.querySelectorAll('[data-state="awaiting sync"]')).toHaveLength(1);
  expect(container.querySelectorAll('[data-state="already restored"]')).toHaveLength(1);
  expect(screen.getByRole('button',{name:'Build a restore proposal for 2 rows'})).toBeDefined();
  expect(container.querySelector('.cq-counts')?.textContent).toBe('ROWS IN BATCH7READY TO RESTORE2BLOCKED4NOTHING TO DO1');
  expect(screen.getAllByText('—')).toHaveLength(2);
});
it('uses the exact measured column widths',()=>{
  const {container}=render(<Screen data={ready}/>);
  expect([...container.querySelectorAll('col')].map(col=>col.style.width)).toEqual(['130px','300px','96px','92px','92px','168px','300px','118px']);
});

it('shows coordinated restore refusal and offers no build action for its rows',()=>{
  const preview=restore.props.preview!;
  const rows=preview.rows.slice(0,3).map(row=>({...row,state:'unsupported' as const,why:COORDINATED_RESTORE_UNAVAILABLE}));
  render(<Screen data={{...restore,props:{...restore.props,preview:{...preview,rows}}}}/>);
  expect(screen.getAllByText(COORDINATED_RESTORE_UNAVAILABLE)).toHaveLength(3);
  expect(screen.getByRole('button',{name:'Build a restore proposal for 0 rows'}).hasAttribute('disabled')).toBe(true);
});

it('disables restore construction for an active reversion even when two rows remain ready',()=>{
  render(<Screen data={{...restore,props:{...restore.props,preview:{...restore.props.preview,blockedReason:'This batch already has an active reversion export.'}}}}/>);
  expect(screen.getByRole('button',{name:'Build a restore proposal for 2 rows'}).hasAttribute('disabled')).toBe(true);
  expect(screen.getByText('This batch already has an active reversion export.')).toBeDefined();
});

it('renders three imported events with resolution and collision evidence and zero write controls',()=>{
  const imported=amazonEntryFixtures();render(<Screen data={{...ready,props:{...ready.props,entries:[ready.props.entries[0]!,...imported]}}}/>);
  const rows=screen.getAllByTestId('timeline-entry');expect(rows).toHaveLength(4);
  const provider=rows.filter(row=>row.getAttribute('data-source')==='amazon');expect(provider).toHaveLength(3);
  expect(screen.getAllByTestId('amazon-observation-provenance')).toHaveLength(3);
  expect(screen.getAllByTestId('amazon-observation-provenance')[2]!.textContent).toContain('identity conflict');
  expect(provider[0]!.textContent).toContain('unresolved');expect(provider[1]!.textContent).toContain('resolved campaign campaign-1');expect(provider[2]!.textContent).toContain('identity conflict');
  for(const row of provider){expect(row.textContent).toContain('SYNTHETIC-MARKET-');expect(row.textContent).toContain('derived identity (provider ID unavailable)');expect(row.querySelectorAll('a,button,summary')).toHaveLength(0);}
  expect(rows[0]!.querySelectorAll('a')).toHaveLength(1);
});

it.each(['admitted','attempted','succeeded','awaiting_observation','partial_failed','observed','needs_attention','refused','blocked'] as const)('renders both creation sources with the %s state', (state) => {
  const entries: ChangeQueueEntry[] = ['campaign_creation','campaign_creation_retry'].map((source,index) => ({
    ...ready.props.entries[0]!, source: source as ChangeQueueEntry['source'], state,
    id:`creation:10000000-0000-4000-8000-00000000000${index+1}`, batchCount:index===0?4:1,
    batchLabel:index===0?'Campaign creation':'Retry of original batch',
    reviewHref:'/campaigns/draft?' + new URLSearchParams({profile:ready.props.profileId,draft:'synthetic',batch:String(index),step:'result'}),
  }));
  render(<Screen data={{...ready,props:{...ready.props,entries}}}/>);
  const rows=screen.getAllByTestId('timeline-entry'); expect(rows).toHaveLength(2);
  expect(rows[0]?.textContent).toContain('Campaign creation'); expect(rows[0]?.textContent).toContain('Approved creation · 4 resources');
  expect(rows[1]?.textContent).toContain('Campaign creation retry'); expect(rows[1]?.textContent).toContain('Retry of original batch');
  expect(rows.every(row=>row.textContent?.includes(state.replaceAll('_',' ')))).toBe(true);
  expect(rows.map(row=>row.querySelector('a')?.getAttribute('href'))).toEqual(entries.map(row=>row.reviewHref));
});
