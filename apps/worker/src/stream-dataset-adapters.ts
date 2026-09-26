import {
  StreamExtensionDataset, StreamExtensionRecord,
  StreamDiagnosticsObservation, StreamBudgetObservation, StreamCampaignObservation,
  StreamAdGroupObservation, StreamAdObservation, StreamTargetObservation,
  StreamClickAggregate, StreamRichMediaAggregate,
} from '@wizard-ads/shared';

/** Recorded contract adapters. Hosted access and wire parity need separate binding approval. */
function adapter(datasetId: StreamExtensionDataset, observation: { parse(value: unknown): unknown }, consumers: readonly string[]) {
  return Object.freeze({ datasetId, contractVersion: 'fixture.v1', enabledByDefault: false,
    provenance: 'synthetic-recorded', consumers,
    parse(raw: unknown): StreamExtensionRecord {
      const record = StreamExtensionRecord.parse(raw);
      if (record.datasetId !== datasetId || record.contractVersion !== 'fixture.v1') throw new Error('Unsupported dataset contract');
      observation.parse(record.observation);
      return record;
    } });
}
export const streamDatasetAdapters = [
  adapter('sponsored-ads-campaign-diagnostics-recommendations', StreamDiagnosticsObservation, ['Recommendations', 'Home', 'Sync status']),
  adapter('sp-budget-recommendations', StreamBudgetObservation, ['Recommendations', 'Home', 'WP-292 budget handoff']),
  adapter('ads-campaign-management-campaigns', StreamCampaignObservation, ['Campaigns', 'Timeline', 'Time Machine']),
  adapter('ads-campaign-management-adgroups', StreamAdGroupObservation, ['Ad groups']),
  adapter('ads-campaign-management-ads', StreamAdObservation, ['Products', 'Creatives']),
  adapter('ads-campaign-management-targets', StreamTargetObservation, ['Targets', 'Target 360']),
  adapter('sb-clickstream', StreamClickAggregate, ['Creatives', 'Creative detail', 'Creative campaign']),
  adapter('sb-rich-media', StreamRichMediaAggregate, ['Creatives', 'Creative detail', 'Creative campaign']),
] as const;
const registry = new Map(streamDatasetAdapters.map((entry) => [entry.datasetId, entry]));
if (registry.size !== StreamExtensionDataset.options.length) throw new Error('Stream adapter registry is incomplete');
export function parseRegisteredStreamDataset(raw: unknown): StreamExtensionRecord {
  const id = StreamExtensionDataset.parse(raw !== null && typeof raw === 'object' && 'datasetId' in raw ? raw.datasetId : null);
  return registry.get(id)!.parse(raw);
}
/** SNS wrappers carry transport metadata, never tenant admission or confirmation authority. */
export function unwrapStreamDelivery(body: string): unknown {
  const raw: unknown = JSON.parse(body);
  if (raw !== null && typeof raw === 'object' && 'Type' in raw) {
    if (raw.Type !== 'Notification' || !('Message' in raw) || typeof raw.Message !== 'string') return raw;
    return JSON.parse(raw.Message);
  }
  return raw;
}

export function streamExtensionPolicyFromEnv(env: NodeJS.ProcessEnv) {
  const enabled = env['OPENSPELL_STREAM_EXTENSIONS_ENABLED'] === '1';
  const destinationArn = env['OPENSPELL_STREAM_EXTENSIONS_DESTINATION_ARN'] ?? null;
  if (destinationArn !== null && !/^arn:aws:sqs:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]+$/.test(destinationArn)) throw new Error('Invalid Stream destination');
  if (enabled && destinationArn === null) throw new Error('Stream extension destination is required');
  return { enabled, destinationArn };
}

/** Compare configured transport identity before any delivery can use its binding. */
export function assertStreamQueueDestination(queueUrl: string, destinationArn: string): void {
  const target = new URL(queueUrl), parts = destinationArn.split(':');
  if (parts.length!==6 || target.protocol!=='https:' || target.username || target.password || target.search || target.hash
    || target.hostname!==`sqs.${parts[3]}.amazonaws.com` || target.pathname!==`/${parts[4]}/${parts[5]}`)
    throw new Error('Stream queue URL and destination ARN mismatch');
}
