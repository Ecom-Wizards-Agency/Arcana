// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { rendered, verifyScreen } from '../../render-test-support';
import { descriptor } from './descriptor';
import Screen from './view';
import Loading from '../../../../app/targets/[id]/queue/[changeId]/loading';
import SharedError from '../../shared-error';
import { queueFixture } from '../fixtures';
const ready = { view:'ready' as const, change:queueFixture, back:'/grid' };
verifyScreen(descriptor,[
  {state:'loading',name:'loading',render:() => <Loading />,text:'Loading'},
  {state:'error',name:'error',render:() => <SharedError error={new Error('Synthetic error')} reset={() => {}} />,text:''},
  {state:'gated',name:'gated',render:() => <Screen data={{view:'gated',state:'no-database'}} />,text:'database'},
  {state:'not-measured',name:'missing check evidence',render:() => <Screen data={{...ready,change:{...queueFixture,checks:queueFixture.checks.map(c=>({...c,passed:false,reason:'Not measured'}))}}} />,text:'Not measured'},
  {state:'ready',name:'queued',render:() => <Screen data={ready} />,text:'Awaiting review'},
  {state:'ready',name:'approved',render:() => <Screen data={{...ready,change:{...queueFixture,approvedAt:'2026-08-13T12:01:00Z'}}} />,text:'Approved'},
]);
it('shows all five check outcomes and enables approval only when every check passes',() => {
  const pass = render(<Screen data={ready} />);
  expect(pass.container.querySelectorAll('li')).toHaveLength(5);
  expect(pass.container.querySelector('button')?.disabled).toBe(false);
  const fail = rendered(<Screen data={{...ready,change:{...queueFixture,checks:queueFixture.checks.map((c,i)=>({...c,passed:i!==0}))}}} />);
  expect(fail.querySelector('button')?.disabled).toBe(true);
  expect(fail.textContent).toContain('Fail'); expect(fail.textContent).toContain('Pass');
});

it('does not calculate placement exposure from an incomplete modifier snapshot', () => {
  const content = rendered(<Screen data={{...ready,change:{...queueFixture,context:{...queueFixture.context,placementModifiers:{topOfSearch:null,restOfSearch:0,productPages:0}}}}} />);
  expect(content.textContent).toContain('Current max CPC Not measured');
  expect(content.textContent).toContain('Proposed max CPC Not measured');
});

it('mounts an empty polite status before hydration and disables approval until the handler is ready', () => {
  const initial = rendered(<Screen data={ready} />);
  expect(initial.querySelector('[role="status"]')?.textContent).toBe('');
  expect(initial.querySelector('[role="status"]')?.getAttribute('aria-live')).toBe('polite');
  expect(initial.querySelector('button')?.disabled).toBe(true);
});
it('announces the returned approval record without a navigation or refetch', async () => {
  let resolve!: (response: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>((done) => { resolve = done; }));
  vi.stubGlobal('fetch', fetch);
  try {
    render(<Screen data={ready} />);
    const status = screen.getByRole('status');
    fireEvent.click(screen.getByRole('button', {name:'Approve after checks pass'}));
    expect(status.textContent).toBe('');
    expect((screen.getByRole('button', {name:'Approving…'}) as HTMLButtonElement).disabled).toBe(true);
    resolve(Response.json({approval:{id:queueFixture.id,approvedAt:'2026-08-13T12:01:00Z',approvedBy:queueFixture.createdBy}}));
    await waitFor(() => expect(status.textContent).toContain('Approval was recorded'));
    expect(screen.getByRole('status')).toBe(status);
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally { vi.unstubAllGlobals(); }
});
it('keeps the status empty when the mutation does not return this approval record', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({status:'approved'})));
  try {
    render(<Screen data={ready} />);
    fireEvent.click(screen.getByRole('button', {name:'Approve after checks pass'}));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Approval could not be confirmed'));
    expect(screen.getByRole('status').textContent).toBe('');
  } finally { vi.unstubAllGlobals(); }
});
