import { reconcileProviderGraph } from '@wizard-ads/core';
import { ProviderGraphIntakeReceipt, ProviderGraphReadResult, ProviderGraphStoredEvidence,
  type ProviderGraphAssociation, type ProviderGraphResource, type ProviderGraphScope,
  type ReportCoverageObservation } from '@wizard-ads/shared';

export interface ProviderGraphCollectionStore {
  append(scope: ProviderGraphScope, result: ProviderGraphReadResult): Promise<ProviderGraphIntakeReceipt>;
  read(scope: ProviderGraphScope, at: string): Promise<ProviderGraphStoredEvidence>;
  resolve(scope: ProviderGraphScope, edges: readonly ProviderGraphAssociation[], evidence: ProviderGraphStoredEvidence, at: string): Promise<{ offered: number; verified: number }>;
  /** Bind to packages/db upsertReportCoverage; called only after verified intake and projection. */
  publishCoverage(observation: ReportCoverageObservation, verifiedRows: number): Promise<unknown>;
}

/** No runtime registration: external capability/admission remains a separate prerequisite. */
export async function collectProviderGraph(input: {
  enabled?: boolean; scope: ProviderGraphScope; resource: ProviderGraphResource; observedAt: string;
  provider: { read(): Promise<ProviderGraphReadResult> }; store: ProviderGraphCollectionStore;
}): Promise<{ state: 'disabled' } | { state: 'collected'; receipt: ProviderGraphIntakeReceipt;
  projection: ReturnType<typeof reconcileProviderGraph>; completeness: 'complete' | 'partial' }> {
  if (input.enabled !== true) return { state: 'disabled' };
  const read = ProviderGraphReadResult.parse(await input.provider.read());
  const receipt = ProviderGraphIntakeReceipt.parse(await input.store.append(input.scope, read));
  if (receipt.observations.source !== read.sourceRows || receipt.observations.parsed !== read.parsed
    || receipt.observations.refused !== read.refusals.length || receipt.associations.source !== read.associations.length) {
    throw new Error('Provider graph intake receipt does not explain the provider result');
  }
  const stored = ProviderGraphStoredEvidence.parse(await input.store.read(input.scope,input.observedAt));
  if (stored.persistedObservations < receipt.observations.verified
    || stored.persistedAssociations < receipt.associations.verified) throw new Error('Provider graph evidence missing after intake');
  const projection = reconcileProviderGraph({ scope: input.scope, observations: stored.observations, associations: stored.associations });
  const resolution = await input.store.resolve(input.scope,projection.resolved,stored,input.observedAt);
  if (resolution.offered !== projection.resolved.length || resolution.verified !== resolution.offered) {
    throw new Error('Provider graph resolution count differs from verified endpoints');
  }
  const completeness = read.completeness === 'complete' && projection.unresolved.length === 0
    && projection.conflicts === 0 && projection.refusedScope === 0 ? 'complete' : 'partial';
  const sourceTimes = read.observations.map((row) => row.sourceEventAt).sort();
  const latest = sourceTimes.at(-1) ?? input.observedAt;
  const earliest = sourceTimes[0] ?? input.observedAt;
  await input.store.publishCoverage({ orgId: input.scope.orgId, profileId: input.scope.profileId,
    reportType: `provider_graph:${input.resource}`, grain: 'entity_observation', source: 'product_api',
    status: completeness, earliestDate: earliest.slice(0,10), coveredThrough: latest.slice(0,10),
    settledThrough: null, observedAt: latest, sourceRows: read.sourceRows, parsedRows: read.parsed,
    loadedRows: receipt.observations.verified, refusedRows: read.refusals.length, countsMatch: true },
  receipt.observations.verified);
  return { state: 'collected', receipt, projection, completeness };
}
