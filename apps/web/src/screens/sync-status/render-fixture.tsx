import { context } from '../synthetic-render-fixtures';
import type { ScreenData } from './view';

export const ready = { "view": "ready", "props": { "context": context, "status": { "deadLetters": [], "lifecycle": [], "freshness": [], "jobs": [], "reports": [], "catalogue": [] } } } satisfies ScreenData;

export const catalogueReady: ScreenData = {view:'ready',props:{...ready.props,status:{...ready.props.status,catalogue:
  ['never','empty','complete','failed'].map((state,index)=>({profileLabel:'Synthetic profile',marketplaceId:'SYNTHETIC-MARKET',family:'product_metadata',selectorKey:`selector-${index}`,enabled:false,reportingRecoveryVerified:true,
    coveredFrom:state==='never'?null:'2026-09-14T00:00:00.000Z',coveredThrough:state==='never'?null:'2026-09-15T00:00:00.000Z',observedAt:state==='never'?null:state==='failed'?'2026-09-10T00:00:00.000Z':'2026-09-15T00:00:00.000Z',
    sourceRows:state==='never'?null:state==='empty'?0:3,loadedRows:state==='never'?null:state==='empty'?0:3,cursorFailure:state==='failed'?'Synthetic cursor failure':null}))}}};
