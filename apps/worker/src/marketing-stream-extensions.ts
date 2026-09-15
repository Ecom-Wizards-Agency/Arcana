import { createHash } from 'node:crypto';
import { StreamExtensionDataset, StreamExtensionEvent, StreamExtensionRecord,
  StreamExtensionReceipt, type StreamExtensionBinding, type StreamExtensionRefusal } from '@wizard-ads/shared';
import { projectStreamExtensionEvent, resolveStreamExtensionBinding, retainStreamExtensionDelivery,
  readProviderGraphEvidence, recordProviderGraphResolution,
  type DbHandle } from '@wizard-ads/db';
import { reconcileProviderGraph } from '@wizard-ads/core';
import type { IngestionRegistry } from './ingestion-registry.js';
import { ingestionSource } from './ingestion-sources.js';
import { PermanentJobError } from './permanent-job-error.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
export interface StreamExtensionIntakeStore {
  binding(subscriptionId: string, destinationArn: string): Promise<StreamExtensionBinding | null>;
  retain(input: Parameters<typeof retainStreamExtensionDelivery>[1]): Promise<StreamExtensionReceipt>;
}
/** Only canonical synthetic adapters are available on this base. Production wire admission stays unsupported. */
export class StreamExtensionIntake {
  constructor(private readonly options: { store: StreamExtensionIntakeStore; destinationArn: string;
    enabled?: boolean; syntheticAdapter?: boolean; now?: () => Date }) {}

  async retain(message: { messageId: string; body: string }): Promise<StreamExtensionReceipt> {
    const receivedAt = (this.options.now?.() ?? new Date()).toISOString();
    let decoded = 0;
    let event: StreamExtensionEvent | null = null;
    let reason: StreamExtensionRefusal | null = null;
    let raw: unknown;
    try { raw = JSON.parse(message.body); } catch { reason = 'invalid_json'; }
    if (reason === null) {
      decoded = 1;
      const parsed = StreamExtensionRecord.safeParse(raw);
      if (!parsed.success) reason = 'unsupported_schema';
      else if (!this.options.enabled) reason = 'disabled';
      else if (!this.options.syntheticAdapter || parsed.data.contractVersion !== 'fixture.v1') reason = 'unsupported_schema';
      else {
        const r = parsed.data;
        const binding = await this.options.store.binding(r.subscriptionId, this.options.destinationArn);
        if (!binding || ['datasetId', 'advertiserId', 'marketplaceId', 'region', 'destinationArn', 'contractVersion']
          .some((key) => Reflect.get(binding, key) !== Reflect.get(r, key)) || r.destinationArn !== this.options.destinationArn)
          reason = 'binding_mismatch';
        else if (!binding.enabled || !binding.capabilityVerified) reason = 'disabled';
        else if (!binding.confirmed) reason = 'unconfirmed';
        else event = StreamExtensionEvent.parse({ orgId: binding.orgId, profileId: binding.profileId,
          identity: hash(canonical([binding.orgId, binding.profileId, r.datasetId, r.subscriptionId, r.eventId, r.revision])),
          payloadFingerprint: hash(canonical(r)), receivedAt, record: r });
      }
    }
    const result = await this.options.store.retain({ deliveryId: hash(canonical([this.options.destinationArn, message.messageId])),
      bodyFingerprint: hash(message.body), receivedAt, decoded, event, reason });
    const receipt = StreamExtensionReceipt.parse(result);
    if (receipt.deliveryId !== hash(canonical([this.options.destinationArn, message.messageId])) || receipt.bodyFingerprint !== hash(message.body))
      throw new Error('Stream receipt does not explain delivery');
    return receipt;
  }
}

/** Used by the existing receiver before hourly parsing. It never confirms an SNS URL. */
export function isStreamExtensionDelivery(body: string): boolean {
  try {
    let raw: unknown = JSON.parse(body);
    if (raw !== null && typeof raw === 'object' && 'Message' in raw && typeof raw.Message === 'string') raw = JSON.parse(raw.Message);
    return raw !== null && typeof raw === 'object' && 'datasetId' in raw && StreamExtensionDataset.safeParse(raw.datasetId).success;
  } catch { return false; }
}
export function createStreamExtensionIntake(handle: DbHandle, destinationArn: string) {
  return new StreamExtensionIntake({ destinationArn, store: {
    binding: (subscriptionId, destination) => resolveStreamExtensionBinding(handle, subscriptionId, destination),
    retain: (input) => retainStreamExtensionDelivery(handle, input),
  } });
}

export function registerStreamExtensionProjection(registry: Pick<IngestionRegistry, 'register'>,
  handle: DbHandle, enabled: () => boolean = () => false) {
  registry.register({
    source: { ...ingestionSource('marketing_stream.extensions.project'), jobType: 'marketing_stream.extensions.project' },
    plan: ({ payload }) => {
      if (!enabled()) throw new PermanentJobError('Stream extension projections are disabled');
      return payload;
    },
    execute: async (payload) => {
      const result = await projectStreamExtensionEvent(handle, payload);
      if (result.graphScope !== null) {
        const at = new Date().toISOString();
        const evidence = await readProviderGraphEvidence(handle,result.graphScope,at);
        const graph = reconcileProviderGraph({ scope: result.graphScope,
          observations: evidence.observations, associations: evidence.associations });
        const resolution = await recordProviderGraphResolution(handle,result.graphScope,graph.resolved,evidence,at);
        if (resolution.offered !== graph.resolved.length || resolution.verified !== resolution.offered)
          throw new Error('Stream graph resolution count mismatch');
      }
      return result;
    },
    counts: (result) => result,
    coverage: { target: (result) => ({ reportType: result.event.record.datasetId, grain: 'event',
      status: 'partial', earliestDate: result.event.record.eventTime.slice(0, 10),
      coveredThrough: result.event.record.eventTime.slice(0, 10), settledThrough: null,
      observedAt: result.event.record.eventTime }) },
  });
}
