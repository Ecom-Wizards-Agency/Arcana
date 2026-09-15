import { profile } from '../synthetic-render-fixtures';
import type { ScreenData } from './view';

export const ready = { "view": "ready", "props": { "research": {schedules:[],campaigns:[],results:{}}, "profile": profile, "summary": { "firstLocalDate": null, "lastLocalDate": null, "timeZone": null, "settledHours": 0, "settlingHours": 0, "revisedHours": 0, "cappedHours": 0, "campaigns": [] }, "workspace": { "facts": [], "proposals": [], "coverage": { "ledgerMessages": 0, "latestReceivedAt": null }, "maturityPolicyConfigured": false }, "campaignId": null, "campaignChoices": [], "metric": "roas", "showAllEvidence": false, "from": '2026-08-29', "to": '2026-08-29', "selectedFacts": [], "evidence": [], "cellMap": new Map(), "proposals": [] } } satisfies ScreenData;

import type {DaypartingSchedule,DaypartingEvidenceSummary,DaypartingScheduleStatus} from '@wizard-ads/shared';
import {emptyDaypartingGrid,paintDaypartingGrid} from '@wizard-ads/core';
const id='22222222-2222-4222-8222-222222222222';
export const dayEvidence:DaypartingEvidenceSummary={start:'2026-06-01',end:'2026-06-07',campaignIds:['synthetic-campaign'],
 factRows:168,
 settledRows:168,settlingRows:0,revisedRows:0,
 coveredCampaignIds:['synthetic-campaign'],
 maturityPolicyConfigured:true,spend:420,sales:1260,orders:168,
 fingerprint:'synthetic-evidence'};
export function syntheticSchedule(status:DaypartingScheduleStatus='draft'):DaypartingSchedule{
 const modifiers=paintDaypartingGrid(emptyDaypartingGrid(),[1,2,3,4,5],17,21,37);
 return {id,orgId:id,profileId:id,name:'Synthetic schedule',timezone:'UTC',modifiers,status,campaignIds:['synthetic-campaign'],review:status==='draft'?null:{reviewedBy:id,reviewedAt:'2026-06-08T00:00:00Z',campaignIds:['synthetic-campaign'],modifiers,evidence:dayEvidence},enabledAt:status==='enabled'||status==='paused'?'2026-06-08T10:00:00Z':null,pausedAt:status==='paused'?'2026-06-09T10:00:00Z':null,sourceProposalId:null,createdAt:'2026-06-01T00:00:00Z',updatedAt:'2026-06-08T00:00:00Z',nextRunAt:status==='enabled'?'2026-06-08T11:07:00Z':null,
 cadenceLimits:status==='enabled'?{campaignLimit:1,maximumAdjustmentPercent:37}:null,
 profileKillSwitch:status==='enabled'?false:null};
}
export function daypartingFixture(status:DaypartingScheduleStatus='draft'):Extract<ScreenData,{view:'ready'}>['props']{
 return {...ready.props,profile:{...profile,id},from:'2026-06-01',to:'2026-06-07',research:{schedules:[syntheticSchedule(status)],campaigns:[{id:'synthetic-campaign',name:'Synthetic campaign'}],results:{}}};
}

import type {MarketingStreamHourlyFact} from '@wizard-ads/shared';
import {buildDaypartingHeatmap,summarizeDaypartingFacts} from '../../dayparting/view';
export function measuredDaypartingFixture() {
 const data=daypartingFixture();
 const facts:MarketingStreamHourlyFact[]=Array.from({length:168},(_,i)=>{
  const hour=i%24,day=Math.floor(i/24),date=`2026-06-${String(day+1).padStart(2,'0')}`;
  return {profileId:data.profile.id,adProduct:'SP',campaignId:'synthetic-campaign',utcHour:`${date}T${String(hour).padStart(2,'0')}:00:00Z`,profileTimeZone:'UTC',localDate:date,localHour:hour,localDayOfWeek:(day+1)%7,currencyCode:'USD',
 impressions:20,clicks:3,cost:hour%4+1,sales:(hour%4+1)*3,purchases:1,budgetUsagePercent:null,budgetCapped:false,
 settlingState:'settled',sourceEvents:2};
 });
 return {...data,selectedFacts:facts,evidence:facts,campaignChoices:['synthetic-campaign'],summary:summarizeDaypartingFacts(facts),cellMap:new Map(buildDaypartingHeatmap(facts,'roas').map(cell=>[`${cell.dayOfWeek}|${cell.hour}`,cell])),workspace:{...data.workspace,facts,
 maturityPolicyConfigured:true,coverage:{ledgerMessages:336,latestReceivedAt:'2026-06-08T00:00:00Z'}}};
}
