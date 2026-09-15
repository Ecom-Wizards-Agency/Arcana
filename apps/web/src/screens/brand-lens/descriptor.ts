import type {ScreenDescriptor} from '../types';
import type {load} from './load';
import type Screen from './view';
export const descriptor={id:'brand-lens',path:'/brand-lens',route:'page',nav:{group:'research',label:'Brand lens',icon:'icon/brand-lens',order:3},
 guard:{kind:'requested',heading:'Brand lens'},prefetch:'expensive',rollout:{enabled:false,envFlag:'WIZARD_ADS_BRAND_LENS_ENABLED'},states:['loading','error','gated','empty','not-measured'],entry:'gate-message',specs:[{file:'research-brand-lens.spec.ts',suite:'route-acceptance'}],
 load:(actor,params)=>import('./load').then(m=>m.load(actor,params)),client:():Promise<typeof Screen>=>import('./view').then(m=>m.default)} satisfies ScreenDescriptor<Awaited<ReturnType<typeof load>>>;
