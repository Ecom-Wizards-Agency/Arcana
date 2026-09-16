/** Synthetic worker evidence. No provider or database authority is created by this fixture. */
import { createHash } from 'node:crypto';
import { CampaignCreationBatch, CampaignCreationNodeKind, CampaignCreationNodeV2, CampaignCreationPlanV2,
  CampaignBuilderCheck, orderCampaignCreationNodes, serializeCampaignCreationNodeFingerprint, serializeCampaignCreationPlanFingerprint } from '@wizard-ads/shared';

export const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12,'0')}`;
export const CAMPAIGN=id(12); export const GROUP=id(13); export const AD=id(14); export const TARGET=id(15);
export const hasher={algorithm:'sha256' as const,digest:(text:string)=>createHash('sha256').update(text).digest('hex')};
export function creationBatch() {
  const at='2026-09-15T12:00:00.000Z';
  const expires='2026-09-15T13:00:00.000Z';
  const zero='0'.repeat(64);
  const base={schemaVersion:'openspell.campaign-creation-node.v2',adProduct:'SP',apiDialect:'sp_legacy_v3',fingerprint:zero};
  const create={...base,effect:'irreversible_create',rollback:'none'};
  const ref=(kind:string,nodeId:string)=>({source:'plan_node',kind,nodeId});
  const raw=[{...base,nodeId:id(11),kind:'eligibility.require_product',effect:'read_check',rollback:'not_applicable',
      dependsOn:[],
      payload:{asin:'B000000001',sku:'SYNTHETIC-SKU'}},
    {...create,nodeId:CAMPAIGN,kind:'campaign.create',
      dependsOn:[id(11)],
      payload:{name:'Synthetic campaign',state:'paused',budget:{amount:20,type:'daily',currencyCode:'USD'},schedule:{type:'calendar_dates',startDate:'2026-09-15',endDate:null},portfolioId:null,settings:{product:'SP',targetingType:'manual',biddingStrategy:'manual',placementBidding:{topOfSearch:0,productPages:0,restOfSearch:0}}}},
    {...create,nodeId:GROUP,kind:'ad_group.create',
      dependsOn:[CAMPAIGN],
      payload:{campaign:ref('campaign',CAMPAIGN),name:'Synthetic ad group',state:'paused',defaultBid:1,settings:{product:'SP'}}},
    {...create,nodeId:AD,kind:'ad.create',
      dependsOn:[id(11),GROUP],
      payload:{format:'sp_product_ad',adGroup:ref('ad_group',GROUP),product:ref('product',id(11)),state:'paused'}},
    {...create,nodeId:TARGET,kind:'target.create',
      dependsOn:[GROUP],
      payload:{targetType:'keyword',parent:ref('ad_group',GROUP),scope:'ad_group',polarity:'positive',text:'synthetic keyword',matchType:'exact',bid:1,state:'paused'}}];
  const nodes=orderCampaignCreationNodes(raw.map((node)=>CampaignCreationNodeV2.parse(node))).map((node)=>({...node,fingerprint:hasher.digest(serializeCampaignCreationNodeFingerprint(node))}));
  const unbound=CampaignCreationPlanV2.parse({schemaVersion:'openspell.campaign-creation-plan.v2',id:id(1),orgId:id(2),profileId:id(3),marketplaceId:'ATVPDKIKX0DER',adProduct:'SP',apiDialect:'sp_legacy_v3',providerScope:{amazonProfileId:'900000000001',connectionId:id(4),region:'NA',marketplaceId:'ATVPDKIKX0DER',currencyCode:'USD',accountType:'seller'},
    generatedAt:at,frozenAt:at,expiresAt:expires,nodes,fingerprint:zero,
    counts:{totalNodes:5,readChecks:1,irreversibleCreates:4,byKind:Object.fromEntries(CampaignCreationNodeKind.options.map((kind)=>[kind,nodes.filter((node)=>node.kind===kind).length]))},
    noRollbackAcknowledgement:{required:true,rollback:'none',compensatingAction:'separate_reviewed_pause_or_archive'}});
  const plan={...unbound,fingerprint:hasher.digest(serializeCampaignCreationPlanFingerprint(unbound))};
  return CampaignCreationBatch.parse({id:id(290),draftId:id(291),draftRevision:2,actorId:id(292),plan,admittedAt:at,expiresAt:expires,environmentGateVersion:id(293),profileGrantVersion:id(294),
    lineage:null,
    productChecks:[{nodeId:id(11),providerEntityId:'B000000001',
      observedAt:at}],
    validation:{planFingerprint:plan.fingerprint,recipeFingerprint:zero,checkedAt:at,checks:CampaignBuilderCheck.shape.id.options.map((id)=>({id,label:id,
      source:'Synthetic measured evidence',status:'passed',blocking:false,currentValue:'Synthetic value',requiredAction:''}))},
    nodes:nodes.filter((node)=>node.effect==='irreversible_create').map((node)=>({nodeId:node.nodeId,nodeFingerprint:node.fingerprint,intent:null,result:null,observation:null,refusal:null}))});
}
