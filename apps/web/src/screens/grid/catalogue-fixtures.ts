import { ProductEvidence, ProductMetadataSnapshot, ProductEligibilitySnapshot, type ChangeQueueEntry } from '@wizard-ads/shared';

export const catalogueScope={orgId:'10000000-0000-4000-8000-000000000001',profileId:'10000000-0000-4000-8000-000000000002',marketplaceId:'SYNTHETIC-MARKET'};
const at='2026-09-15T00:00:00.000Z';
export function catalogueMetadata(asin='SYNTHETIC4') {
  const absent={state:'absent',reason:null};
  return ProductMetadataSnapshot.parse({scope:catalogueScope,asin,sku:null,adProduct:'SP',
    provenance:{family:'product_metadata',contractVersion:'v1-synthetic',providerObservedAt:null,acquiredAt:at,retrievedAt:'2026-09-15T00:00:05.000Z'},
    title:{state:'returned',value:'Synthetic listing',sourceField:'title'},imageUrl:absent,category:absent,variationAsins:absent,
    price:{state:'returned',value:{amount:0,currency:'USD'},sourceField:'priceToPay'},basisPrice:absent,
    availability:{state:'returned',value:'AVAILABLE',sourceField:'availability'},inventoryQuantity:absent,bestSellerRank:{state:'returned',value:0,sourceField:'bestSellerRank'}});
}
export function catalogueEvidenceFixtures():ProductEvidence[] {
  return ['missing','missing','partial','partial','measured','measured','stale','stale','partial'].map((availability,index)=>{
    const asin=`SYNTHETIC${index}`;
    let metadata=index===0||index===3?null:catalogueMetadata(asin);
    if(index===1&&metadata) {
      const absent={state:'refused' as const,reason:'Provider refused this ASIN'};
      metadata={...metadata,title:absent,price:absent,availability:absent,bestSellerRank:absent};
    }
    if(index===2&&metadata) metadata={...metadata,price:{state:'absent',reason:null},bestSellerRank:{state:'absent',reason:null}};
    if(index===6&&metadata) metadata={...metadata,provenance:{...metadata.provenance,acquiredAt:'2026-09-10T00:00:00.000Z'}};
    const eligibility=index===0?null:ProductEligibilitySnapshot.parse({scope:catalogueScope,asin,sku:null,adProduct:'SP',verdict:index<3?'unknown':index===5?'ineligible':'eligible',reasons:[{code:`SYNTHETIC_REASON_${index}`,message:`Measured product reason ${index}`,severity:null}],
      provenance:{family:'product_eligibility',contractVersion:'v1-synthetic',providerObservedAt:null,acquiredAt:index===7?'2026-09-10T00:00:00.000Z':at,retrievedAt:at}});
    const candidates=index===8&&eligibility?[{...eligibility,sku:'sku-a'},{...eligibility,sku:'sku-b',verdict:'ineligible' as const}]:eligibility?[eligibility]:[];
    return ProductEvidence.parse({scope:catalogueScope,asin,availability,metadata,eligibility:index===8?null:eligibility,
      metadataAvailability:index<2||index===3?'missing':index===6?'stale':'measured',eligibilityAvailability:index<3?'missing':index===7?'stale':index===8?'partial':'measured',
      eligibilityIdentity:index===0?'missing':index===8?'ambiguous':'explicit',eligibilityCandidates:candidates});
  });
}
export function amazonEntryFixtures():ChangeQueueEntry[] {
  return ['unresolved','resolved','conflict'].map((kind,index)=>({
    id:`amazon:synthetic-${index}`,when:'2026-09-05T10:00:00.000Z',entity:`Imported ${kind} event`,entityType:'campaign',entityId:`campaign-${index}`,field:'BUDGET_AMOUNT',oldValue:'1',newValue:'2',source:'amazon',state:'observed',
    batchId:null,batchLabel:null,batchCount:null,experimentStart:false,candidateCount:0,acknowledgedAt:null,acknowledgedBy:null,reviewHref:null,actor:{kind:'unknown',name:null},
    amazonObservation:{marketplaceId:`SYNTHETIC-MARKET-${index}`,retrievedAt:'2026-09-15T00:00:00.000Z',identityQuality:'derived',identityAmbiguity:'provider_id_unavailable',identityConflict:kind==='conflict',resolution:kind==='resolved'?'resolved':'unresolved',resolvedEntityType:kind==='resolved'?'campaign':null,resolvedAmazonId:kind==='resolved'?'campaign-1':null},
  }));
}
