// @vitest-environment jsdom
import { expect, it } from 'vitest';
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
  const pass = rendered(<Screen data={ready} />);
  expect(pass.querySelectorAll('li')).toHaveLength(5);
  expect(pass.querySelector('button')?.disabled).toBe(false);
  const fail = rendered(<Screen data={{...ready,change:{...queueFixture,checks:queueFixture.checks.map((c,i)=>({...c,passed:i!==0}))}}} />);
  expect(fail.querySelector('button')?.disabled).toBe(true);
  expect(fail.textContent).toContain('Fail'); expect(fail.textContent).toContain('Pass');
});

it('does not calculate placement exposure from an incomplete modifier snapshot', () => {
  const content = rendered(<Screen data={{...ready,change:{...queueFixture,context:{...queueFixture.context,placementModifiers:{topOfSearch:null,restOfSearch:0,productPages:0}}}}} />);
  expect(content.textContent).toContain('Current max CPC Not measured');
  expect(content.textContent).toContain('Proposed max CPC Not measured');
});
