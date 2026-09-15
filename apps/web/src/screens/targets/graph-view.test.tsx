// @vitest-environment jsdom
import { expect,it } from 'vitest';
import { render,screen,within } from '@testing-library/react';
import { Target360 } from './target360';
import { targetFixture } from './fixtures';
import type { Target360GraphEvidence } from './model';
const row:Target360GraphEvidence['rows'][number]={relation:'parent',kind:'campaign',providerId:'provider-campaign',version:null,
  source:'marketing_stream',sourceEventAt:'2026-09-15T00:00:00Z',stale:false};
it.each(['observed','partial','stale'] as const)('renders counted %s provider associations without changing target facts',(status)=>{
  render(<Target360 model={{...targetFixture,graph:{status,rows:[{...row,stale:status==='stale'}],unresolvedCount:status==='partial'?1:0}}}
    currencyCode="USD" back="/grid" savedView={null}/>);
  const panel=screen.getByRole('region',{name:'Provider associations'});
  expect(within(panel).getAllByRole('row')).toHaveLength(2);
  expect(panel.textContent).toContain('Amazon Marketing Stream');expect(panel.textContent).toContain('1 resolved');
  if(status==='stale')expect(panel.textContent).toContain('evidence is stale');
  if(status==='partial')expect(panel.textContent).toContain('1 awaiting endpoint evidence');
  expect(screen.getByRole('heading',{level:1}).textContent).toBe(targetFixture.payload.target.targeting);
});
it('renders optional missing graph evidence without fabricated association rows',()=>{
  render(<Target360 model={targetFixture} currencyCode="USD" back="/grid" savedView={null}/>);
  const panel=screen.getByRole('region',{name:'Provider associations'});
  expect(panel.textContent).toContain('No provider associations measured');expect(within(panel).queryAllByRole('row')).toHaveLength(0);
});
