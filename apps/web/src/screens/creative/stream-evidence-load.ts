import { readStreamConsumerSource } from '@wizard-ads/db';
import { deriveStreamConsumerEvidence } from '@wizard-ads/core';
/** Authenticated loader supplies the handle; DB reads, core resolves the evidence. */
export async function readStreamConsumerEvidence(handle: Parameters<typeof readStreamConsumerSource>[0], input: Parameters<typeof readStreamConsumerSource>[1]) {
  return deriveStreamConsumerEvidence(await readStreamConsumerSource(handle,input),input);
}
