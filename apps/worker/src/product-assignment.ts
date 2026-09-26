import { deriveProductAssignment } from '@wizard-ads/core';
import { readProductAssignmentEvidence, persistProductAssignments, withProductAssignmentRefresh, type DbHandle } from '@wizard-ads/db';

export interface ProductAssignmentRefreshCounts {
  /** Ad groups whose evidence was read and derived. */
  parsed: number;
  /** Assignment rows read back from the table after the write. */
  saved: number;
  offered: number;
  changed: number;
  unchanged: number;
  manual: number;
}
/** Reported in every SP entity-sync result; a failure is retried by the next sync. */
export type ProductAssignmentRefreshOutcome =
  | ({ status: 'refreshed' } & ProductAssignmentRefreshCounts)
  | { status: 'failed'; reason: string };

/** Runs only after the product-ad mirror and its change ledger are committed. */
export async function refreshProductAssignments(handle: DbHandle, profile: {orgId:string;id:string}, now = new Date().toISOString()): Promise<ProductAssignmentRefreshCounts> {
  const scope={orgId:profile.orgId,profileId:profile.id};
  return withProductAssignmentRefresh(handle,scope,async (snapshot) => {
    const evidence=await readProductAssignmentEvidence(snapshot,scope,now);
    const counts=await persistProductAssignments(snapshot,scope,evidence.map(deriveProductAssignment),now);
    // Program rule 4: parsed ad groups against rows read back, inside the transaction so a shortfall writes nothing.
    if(counts.saved!==evidence.length) throw new Error(`Assignment refresh parsed ${evidence.length} ad groups but read back ${counts.saved}`);
    return {parsed:evidence.length,...counts};
  });
}
