import { context } from '../synthetic-render-fixtures';
import type { ScreenData } from './view';

const stage = (name: 'request' | 'poll' | 'fetch' | 'load') => ({
  stage: name, lastSucceededAt: null, lastFailedAt: null, lastErrorClass: null, retrying: 0, dead: 0,
});

export const ready = { "view": "ready", "props": { "context": context, "status": { "deadLetters": [], "lifecycle": [], "freshness": [], "jobs": [], "reports": [], "catalogue": [] }, "lane": { "scope": "organisation", "stages": [stage('request'), stage('poll'), stage('fetch'), stage('load')], "blocking": null, "organisationDead": { "total": 0, "byStage": { "request": 0, "poll": 0, "fetch": 0, "load": 0 }, "reRequested": 0, "resolved": 0 }, "profiles": [] } } } satisfies ScreenData;

export const catalogueReady: ScreenData = {view:'ready',props:{...ready.props,status:{...ready.props.status,catalogue:
  ['never','empty','complete','failed'].map((state,index)=>({profileLabel:'Synthetic profile',marketplaceId:'SYNTHETIC-MARKET',family:'product_metadata',selectorKey:`selector-${index}`,enabled:false,reportingRecoveryVerified:true,
    coveredFrom:state==='never'?null:'2026-09-14T00:00:00.000Z',coveredThrough:state==='never'?null:'2026-09-15T00:00:00.000Z',observedAt:state==='never'?null:state==='failed'?'2026-09-10T00:00:00.000Z':'2026-09-15T00:00:00.000Z',
    sourceRows:state==='never'?null:state==='empty'?0:3,loadedRows:state==='never'?null:state==='empty'?0:3,cursorFailure:state==='failed'?'Synthetic cursor failure':null}))}}};
