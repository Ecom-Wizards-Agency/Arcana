import { CollectorScope, CollectorReceipt, ListingExport, SponsoredPromptImport, type JobType } from '@wizard-ads/shared';
import type { DbHandle } from '@wizard-ads/db';
import { SponsoredPromptInputError } from '@wizard-ads/db';
import { OwnCollectorReferenceError, OwnCollectorConflictError, collectorProfile, readOwnBidMirrors, readListingCollectorCoverage, readCollectorExports, persistEffectiveBidObservations, persistListingSnapshots, importScheduledPrompts } from '@wizard-ads/db/worker';
import { collectorDate, listingFieldChange } from '@wizard-ads/core';
import type { IngestionRegistry, IngestionContext } from '../ingestion-registry.js';
import { ingestionSource } from '../ingestion-sources.js';
import { CollectorRefusalError } from './refusal.js';
import { readCollectorExport } from './exports.js';

type CollectorJob = Extract<JobType,'own_bids.collect'|'own_listings.collect'|'prompts.collect'>;
export interface OwnCollectorDependencies {
  collect(type: CollectorJob, context: IngestionContext<CollectorJob>, at: string): Promise<CollectorReceipt>;
  now(): Date;
}
export function registerOwnCollectors(registry: Pick<IngestionRegistry,'register'>, deps: OwnCollectorDependencies): void {
  for (const type of ['own_bids.collect','own_listings.collect','prompts.collect'] as const) registry.register({
    source: { ...ingestionSource(type),jobType:type,reportType:type },
    plan: (context) => ({ context,at:deps.now().toISOString() }),
    execute: async (plan) => {
      try { return { receipt:CollectorReceipt.parse(await deps.collect(type,plan.context,plan.at)) }; }
      catch (error) {
        if (error instanceof OwnCollectorReferenceError) throw new CollectorRefusalError('unauthorized_reference', error.message);
        if (error instanceof SponsoredPromptInputError) throw new CollectorRefusalError(error.refusalCode, error.message);
        if (error instanceof OwnCollectorConflictError) throw new CollectorRefusalError('malformed_content', error.message);
        throw error;
      }
    },
    counts: (result) => result.receipt.counts,
    coverage: { target: (result,plan) => {
      const observedAt = result.receipt.observedAt ?? '1970-01-01T00:00:00.000Z';
      const date = collectorDate(observedAt,plan.context.profile.timezone);
      return { reportType:type,grain:type,earliestDate:date,coveredThrough:date,observedAt,settledThrough:null,
        status:result.receipt.state === 'measured' && collectorDate(plan.at,plan.context.profile.timezone) === date ? 'complete' : 'partial' };
    } },
  });
}
function empty(state: CollectorReceipt['state']): CollectorReceipt {
  return CollectorReceipt.parse({ counts:{ sourceRows:0,parsedRows:0,refusedRows:0,loadedRows:0,verifiedLoadedRows:0 },inserted:0,alreadyPresent:0,outputIdentities:[],observedAt:null,state });
}
function combine(receipts: CollectorReceipt[]): CollectorReceipt {
  if (!receipts.length) return empty('missing');
  // Independent imports can offer the same durable observation. Preserve offered counts,
  // deduplicate output grain, and account inserts once.
  const outputIdentities = [...new Set(receipts.flatMap((r) => r.outputIdentities))];
  const inserted = receipts.reduce((sum,r) => sum+r.inserted,0);
  return CollectorReceipt.parse({ counts:{ sourceRows:receipts.reduce((s,r)=>s+r.counts.sourceRows,0),parsedRows:receipts.reduce((s,r)=>s+r.counts.parsedRows,0),
    refusedRows:receipts.reduce((s,r)=>s+r.counts.refusedRows,0),loadedRows:outputIdentities.length,verifiedLoadedRows:outputIdentities.length },
    inserted,alreadyPresent:outputIdentities.length-inserted,outputIdentities,observedAt:receipts.flatMap((r)=>r.observedAt ? [r.observedAt] : []).sort()[0] ?? null,
    state:receipts.every((r)=>r.state==='measured') ? 'measured':'partial' });
}
export function postgresOwnCollectors(handle: DbHandle, root: string | undefined, enabled = false): OwnCollectorDependencies {
  return { now:()=>new Date(), collect:async (type,context,at) => {
    if (!enabled) return empty('disabled');
    if (context.payload.orgId !== context.job.orgId || context.payload.profileId !== context.job.profileId) throw new CollectorRefusalError('scope_mismatch', 'Collector job scope mismatch');
    const { scope,enabled:profileEnabled } = await collectorProfile(handle,{ orgId:context.job.orgId,profileId:context.job.profileId });
    if (!profileEnabled) return empty('disabled');
    if (type === 'own_bids.collect') {
      const rows = await readOwnBidMirrors(handle,scope,at);
      const result = await persistEffectiveBidObservations(handle,scope,rows);
      return rows.some((r)=>r.bid===null || r.bidding===null || r.placementProvenance===null || r.audienceProvenance===null || Object.values(r.bidding.placements).some((value)=>value===null)) ? { ...result,state:'partial' } : result;
    }
    const receipts: CollectorReceipt[] = [];
    const sourceImports: NonNullable<CollectorReceipt['sourceImports']> = [];
    const refs = await readCollectorExports(handle,scope,type==='prompts.collect' ? 'prompts':'listing');
    if (!refs.length && type === 'prompts.collect') return empty('unconfigured');
    for (const ref of refs) {
      if (!ref.enabled) { receipts.push(empty('disabled')); continue; }
      if (ref.scope.marketplace !== scope.marketplace) throw new CollectorRefusalError('scope_mismatch', 'Cross-market export reference');
      const file = await readCollectorExport(root,ref);
      if (!file) { receipts.push(empty(root ? 'missing':'unconfigured')); continue; }
      if (type==='prompts.collect') {
        const parsed = SponsoredPromptImport.safeParse(file.value);
        if (!parsed.success) throw new CollectorRefusalError('malformed_content', 'Malformed prompt export');
        if (parsed.data.profileId !== scope.profileId) throw new CollectorRefusalError('scope_mismatch', 'Cross-profile prompt export');
        const imported = await importScheduledPrompts(handle,ref,file.fingerprint,parsed.data,at);
        receipts.push(imported); sourceImports.push({ referenceId: ref.id, receipt: imported });
      } else {
        assertListingScope(file.value, scope);
        const parsed = ListingExport.safeParse(file.value);
        if (!parsed.success) throw new CollectorRefusalError('malformed_content', 'Malformed listing export');
        const imported = await persistListingSnapshots(handle,scope,parsed.data.rows,listingFieldChange);
        receipts.push(imported); sourceImports.push({ referenceId: ref.id, receipt: imported });
      }
    }
    if (type === 'own_listings.collect') {
      // Imports already verify their own offered/output counts. Coverage reads the
      // persisted field identities once; it never feeds output back into imports.
      const coverage = await readListingCollectorCoverage(handle, scope, at);
      return CollectorReceipt.parse({ ...coverage, sourceImports, state: receipts.some((receipt) => receipt.state !== 'measured') ? 'partial' : coverage.state });
    }
    return CollectorReceipt.parse({ ...combine(receipts), sourceImports });
  } };
}

function assertListingScope(value: unknown, scope: CollectorScope): void {
  if (value === null || typeof value !== 'object') return;
  const envelopes = [value, ...('rows' in value && Array.isArray(value.rows) ? value.rows : [])];
  for (const envelope of envelopes) {
    if (envelope === null || typeof envelope !== 'object' || !('scope' in envelope)) continue;
    const parsed = CollectorScope.safeParse(envelope.scope);
    if (parsed.success && JSON.stringify(parsed.data) !== JSON.stringify(scope)) throw new CollectorRefusalError('scope_mismatch', 'Cross-profile listing export');
  }
}
