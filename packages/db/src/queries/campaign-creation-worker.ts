import {
  CampaignCreationClaim, CampaignCreationReservation, CampaignCreationProviderResult, CampaignCreationBatchObservation,
  Uuid, type CampaignCreationBatch, type CampaignCreationBatchIntent,
} from '@wizard-ads/shared';
import type { DbHandle, QuerySql } from '../client.js';
import { loadCampaignCreationBatch } from './campaign-creation-batches.js';

/** Worker authority is scoped to SQL commands, never exported as authenticated table DML. */
export function createCampaignCreationLedger(database: Pick<DbHandle, 'sql'>) {
  const service = async <T>(run: (sql: QuerySql) => Promise<T>): Promise<T> => {
    const value = await database.sql.begin(async (sql) => {
      await sql`select set_config('request.jwt.claim.role','service_role',true),set_config('request.jwt.claims','{"role":"service_role"}',true)`;
      await sql`set local role service_role`;
      return { result: await run(sql) };
    });
    return value.result;
  };
  return {
    claim(claimantId: string, profileIds: readonly string[]) {
      Uuid.parse(claimantId); profileIds.forEach((id) => Uuid.parse(id));
      return service(async (sql) => {
        const rows = await sql<{ claim: unknown }[]>`select app.claim_campaign_creation(${claimantId}::uuid,${sql.array([...profileIds])}::uuid[]) as claim`;
        if (rows.length !== 1) throw new Error('Creation claim count mismatch');
        return rows[0]!.claim === null ? null : CampaignCreationClaim.parse(rows[0]!.claim);
      });
    },
    load(claim: CampaignCreationClaim): Promise<CampaignCreationBatch> {
      CampaignCreationClaim.parse(claim);
      return service(async (sql) => {
        const ids = await sql<{ org_id: string; profile_id: string }[]>`select org_id,profile_id from public.campaign_creation_batches where id=${claim.batchId}::uuid`;
        if (ids.length !== 1) throw new Error('Creation batch unavailable');
        const batch = await loadCampaignCreationBatch(sql, ids[0]!.org_id, ids[0]!.profile_id, claim.batchId);
        if (!batch) throw new Error('Creation batch unavailable');
        return batch;
      });
    },
    reserve(claim: CampaignCreationClaim, nodeId: string, intent: CampaignCreationBatchIntent) {
      return service(async (sql) => {
        const rows = await sql<{ reservation: unknown }[]>`select app.reserve_campaign_creation(${claim.batchId}::uuid,
          ${claim.leaseId}::uuid,${nodeId}::uuid,${JSON.stringify(intent)}::jsonb) as reservation`;
        if (rows.length !== 1) throw new Error('Creation reservation count mismatch');
        return CampaignCreationReservation.parse(rows[0]!.reservation);
      });
    },
    result(batchId: string, nodeId: string, raw: CampaignCreationProviderResult) {
      const result = CampaignCreationProviderResult.parse(raw);
      return service(async (sql) => { await sql`select app.record_campaign_creation_result(${batchId}::uuid,${nodeId}::uuid,${JSON.stringify(result)}::jsonb)`; });
    },
    observe(batchId: string, nodeId: string, raw: CampaignCreationBatchObservation) {
      const observation = CampaignCreationBatchObservation.parse(raw);
      return service(async (sql) => { await sql`select app.observe_campaign_creation(${batchId}::uuid,${nodeId}::uuid,${JSON.stringify(observation)}::jsonb)`; });
    },
    settle(claim: CampaignCreationClaim) {
      return service(async (sql) => { await sql`select app.settle_campaign_creation(${claim.batchId}::uuid,${claim.leaseId}::uuid)`; });
    },
  };
}
