import { IngestionSource, type IngestionLane, type JobType } from '@wizard-ads/shared';

/** Ordered once so deployed claim-set serialization remains stable. */
export const INGESTION_SOURCES: readonly IngestionSource[] = [
  { jobType: 'asset-library.search', source: 'amazon_ads', reportType: 'asset_library_assets', laneAffinity: ['integrations'], counts: ['sourceRows', 'parsedRows', 'loadedRows', 'refusedRows'] },
  { jobType: 'retail.report.request', source: 'amazon_spapi', laneAffinity: ['integrations'], counts: ['sourceRows', 'parsedRows', 'refusedRows', 'canonicalRows', 'verifiedLoadedRows'] },
  { jobType: 'aba.report.request', source: 'amazon_spapi', laneAffinity: ['integrations'], counts: ['sourceRows', 'parsedRows', 'refusedRows', 'canonicalRows', 'verifiedLoadedRows'] },
  { jobType: 'catalogue.report.request', source: 'amazon_spapi', laneAffinity: ['integrations'], counts: ['sourceRows', 'parsedRows', 'refusedRows', 'canonicalRows', 'verifiedLoadedRows'] },
  { jobType: 'provider.evidence.collect', source: 'amazon_provider_evidence', laneAffinity: ['integrations'], counts: ['source', 'parsed', 'refused', 'duplicates', 'canonical', 'written', 'existing', 'readback'] },
  ...(['own_bids.collect','own_listings.collect','prompts.collect'] as const).map((jobType) => ({ jobType, source: jobType, reportType: jobType, laneAffinity: ['integrations'] as IngestionLane[], counts: ['sourceRows','parsedRows','refusedRows','loadedRows','verifiedLoadedRows'] })),
  { jobType: 'translation.request', source: 'target_translation', laneAffinity: ['integrations'], counts: ['requested', 'completed', 'superseded', 'alreadyCompleted'] },
  { jobType: 'budget_usage.collect', source: 'amazon_ads_api', reportType: 'campaign_budget_usage', laneAffinity: ['integrations'], counts: ['selected', 'requested', 'returned', 'failed', 'sourceRows', 'parsedRows', 'refusedRows', 'loadedRows', 'existingRows', 'verifiedLoadedRows'] },
  { jobType: 'budget_usage.stream', source: 'amazon_marketing_stream', reportType: 'campaign_budget_usage', laneAffinity: ['integrations'], counts: ['selected', 'requested', 'returned', 'failed', 'sourceRows', 'parsedRows', 'refusedRows', 'loadedRows', 'existingRows', 'verifiedLoadedRows'] },
  { jobType: 'ads.product_metadata.sync', source: 'amazon_ads_product_metadata', laneAffinity: ['integrations'], counts: ['requestedMembers','pages','sourceRows','parsedRows','refusedRows','duplicates','canonicalRows','writtenRows','existingRows','verifiedRows'] },
  { jobType: 'ads.product_eligibility.sync', source: 'amazon_ads_product_eligibility', laneAffinity: ['integrations'], counts: ['requestedMembers','pages','sourceRows','parsedRows','refusedRows','duplicates','canonicalRows','writtenRows','existingRows','verifiedRows'] },
  { jobType: 'ads.validation_configurations.sync', source: 'amazon_ads_validation_configurations', laneAffinity: ['integrations'], counts: ['requestedMembers','pages','sourceRows','parsedRows','refusedRows','duplicates','canonicalRows','writtenRows','existingRows','verifiedRows'] },
  { jobType: 'ads.change_history.sync', source: 'amazon_ads_change_history', laneAffinity: ['integrations'], counts: ['requestedMembers','pages','sourceRows','parsedRows','refusedRows','duplicates','canonicalRows','writtenRows','existingRows','verifiedRows'] },
  { jobType: 'entity.sync', source: 'amazon_ads', laneAffinity: ['vercel-default', 'vercel-reduced'], counts: ['listed', 'upserted', 'duplicates'] },
  { jobType: 'creative.sync', source: 'amazon_ads', laneAffinity: ['vercel-default', 'evo-report', 'evo-report-unified'], counts: ['adsReceived', 'adsPersisted'] },
  ...(['report.request', 'report.poll', 'report.fetch'] as const).map((jobType) => ({
    jobType, source: 'amazon_reporting_v3',
    laneAffinity: ['vercel-default', 'evo-report', 'evo-report-unified'] as IngestionLane[],
    counts: jobType === 'report.fetch' ? ['sourceRows', 'parsedRows', 'loadedRows', 'refusedRows'] : ['enqueued'],
  })),
  { jobType: 'recommendations.run', source: 'recommendations', laneAffinity: ['vercel-default', 'vercel-reduced', 'evo-recommendation'], counts: ['evaluated', 'written'] },
  { jobType: 'keepa.sync', source: 'keepa', laneAffinity: ['integrations'], counts: ['requested', 'returned', 'loaded'] },
  { jobType: 'rank.sync', source: 'datadive', laneAffinity: ['integrations'], counts: ['observations', 'loaded'] },
  { jobType: 'economics.sync', source: 'mrp', laneAffinity: ['integrations'], counts: ['asinsSelected', 'rowsLoaded'] },
  { jobType: 'sqp.request', source: 'amazon_spapi', reportType: 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT', laneAffinity: ['integrations'], counts: ['sourceRows', 'parsedRows', 'refusedRows', 'upserts'] },
  { jobType: 'crosscheck.ingest', source: 'secondary_import', laneAffinity: [], counts: ['rowsParsed', 'rowsKept', 'written'] },
  { jobType: 'marketing_stream.normalize', source: 'amazon_marketing_stream', laneAffinity: ['integrations'], counts: ['offered', 'normalized'] },
  { jobType: 'marketing_stream.extensions.project', source: 'amazon_marketing_stream', laneAffinity: ['integrations'], counts: ['received', 'undecodable', 'decoded', 'accepted', 'deduplicated', 'stored', 'rejected', 'deadLettered', 'verifiedStored'] },
  { jobType: 'report.unified.advance', source: 'amazon_unified_reporting', laneAffinity: ['evo-report-unified'], counts: ['received', 'accepted', 'refused'] },
  ...(['sqp.categorize', 'history.bootstrap', 'report.promote'] as const).map((jobType) => ({
    jobType, source: 'unimplemented', laneAffinity: [], counts: ['offered', 'written'],
  })),
].map((source) => Object.freeze(IngestionSource.parse(source)));

export function ingestionLaneJobTypes(lane: IngestionLane): readonly JobType[] {
  return Object.freeze(INGESTION_SOURCES.filter((source) => source.laneAffinity.includes(lane)).map((source) => source.jobType));
}

export function ingestionSource(jobType: JobType): IngestionSource {
  const source = INGESTION_SOURCES.find((source) => source.jobType === jobType);
  if (!source) throw new Error('Missing ingestion source descriptor');
  return source;
}
