import { isDeepStrictEqual } from 'node:util';
import { ControlMirrorMergeCounts, ControlMirrorMergeRequest } from '@wizard-ads/shared/sp-write-mirror';
import type { DbHandle } from '../client.js';

type Snapshot = Record<string, unknown>;
type Existing = {
  amazonId: string; snapshot: Snapshot; deletedAt: string | null; syncedAt: string;
  controlObservedAt: string | null; completeControls: unknown; controlCurrent: boolean; entityCurrent: boolean;
};
type Change = { amazonId: string; entityName: unknown; field: string; oldValue: unknown; newValue: unknown };
const baseColumns = { amazonId: 'amazon_id', adProduct: 'ad_product', name: 'name', state: 'state' };
const campaignColumns = { ...baseColumns, portfolioId: 'portfolio_amazon_id', budgetAmount: 'budget_amount',
  budgetType: 'budget_type', targetingType: 'targeting_type', biddingStrategy: 'bidding_strategy',
  placementBidding: 'placement_bidding', startDate: 'start_date', endDate: 'end_date' };
const targetColumns = { ...baseColumns, campaignId: 'campaign_id', adGroupId: 'ad_group_id',
  expression: 'expression', resolvedExpression: 'resolved_expression', bid: 'bid' };

/**
 * Lock order matches native mirror promotion: org, profile, entity rows. Stale
 * listings cannot overwrite a promoted control or its tombstone. A partial
 * campaign listing cannot manufacture complete audience/dayparting evidence.
 */
export async function mergeControlMirror(
  handle: Pick<DbHandle, 'sql'>, rawRequest: ControlMirrorMergeRequest,
): Promise<ControlMirrorMergeCounts> {
  const request = ControlMirrorMergeRequest.parse(rawRequest);
  const campaign = request.entityType === 'campaign';
  const table = campaign ? 'campaigns' : 'targets';
  const head = campaign ? 'bidding_observed_at' : 'bid_observed_at';
  const contextKey = campaign ? 'app.campaign_control_read_started_at' : 'app.target_bid_read_started_at';
  const columns = campaign ? campaignColumns : targetColumns;
  const projection = Object.entries(columns).map(([property, column]) => `'${property}', ${column}`).join(', ');
  return handle.sql.begin(async (sql) => {
    const org = await sql`select id from public.orgs where id = ${request.orgId}::uuid for key share`;
    const profile = await sql`select id from public.ad_profiles
      where org_id = ${request.orgId}::uuid and id = ${request.profileId}::uuid for update`;
    if (org.length !== 1 || profile.length !== 1) throw new Error('control mirror scope unavailable');
    const [window] = await sql<{ valid: boolean; previous: string | null }[]>`
      select ${request.readStartedAt}::timestamptz <= clock_timestamp() as valid,
        current_setting(${contextKey}, true) as previous`;
    if (!window?.valid) throw new Error('control mirror read window is in the future');
    await sql`select set_config(${contextKey}, ${request.readStartedAt}, true)`;
    // All interpolated identifiers below are constants selected above, never request data.
    const existing = await sql.unsafe<Existing[]>(`
      select amazon_id as "amazonId", jsonb_build_object(${projection}) as snapshot,
        to_char(deleted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "deletedAt",
        to_char(synced_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "syncedAt",
        to_char(${head} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "controlObservedAt",
        ${campaign ? 'bidding_control_state' : 'null'} as "completeControls",
        (${head} is null or ${head} <= $3::timestamptz) as "controlCurrent",
        synced_at <= $3::timestamptz as "entityCurrent"
      from public.${table} where org_id = $1::uuid and profile_id = $2::uuid
      order by amazon_id for update`, [request.orgId, request.profileId, request.readStartedAt]);
    const byId = new Map(existing.map((row) => [row.amazonId, row]));
    const seen = new Set(request.rows.map((row) => row.amazonId));
    const counts: ControlMirrorMergeCounts = { listed: request.rows.length, upserted: 0,
      currentControlInputs: 0, staleControlInputs: 0, changes: 0, tombstonesOffered: 0,
      tombstoned: 0, staleTombstones: 0, invalidatedCompleteControls: 0 };
    const changes: Change[] = [];
    const rows = request.rows.map((row) => {
      const prior = byId.get(row.amazonId);
      if (prior && prior.snapshot['adProduct'] !== row.adProduct) throw new Error('control mirror product identity changed');
      const { profileId: _profileId, syncedAt: _syncedAt, entityType: _entityType, ...incoming } = row;
      const current = !prior || (prior.controlCurrent && prior.entityCurrent);
      const snapshot: Snapshot = current ? incoming : prior.snapshot;
      if (current) counts.currentControlInputs += 1;
      else counts.staleControlInputs += 1;
      const deletedAt = current ? null : prior!.deletedAt;
      const knownControlsChanged = prior && (campaign
        ? !isDeepStrictEqual(prior.snapshot['placementBidding'], snapshot['placementBidding'])
          || prior.snapshot['biddingStrategy'] !== snapshot['biddingStrategy']
        : prior.snapshot['bid'] !== snapshot['bid']);
      const invalidate = campaign && current && prior?.completeControls != null
        && (knownControlsChanged || prior.deletedAt !== deletedAt);
      if (invalidate) counts.invalidatedCompleteControls += 1;
      // An unchanged partial projection preserves the exact complete evidence and
      // its original observation time; it does not claim a new complete read.
      const controlObservedAt = !current ? prior!.controlObservedAt
        : campaign && prior?.completeControls != null && !invalidate ? prior.controlObservedAt : request.readStartedAt;
      const addChange = (field: string, oldValue: unknown, newValue: unknown) => changes.push({
        amazonId: row.amazonId, entityName: snapshot['name'] ?? null, field, oldValue, newValue });
      if (!prior) addChange('entity', null, snapshot);
      else {
        for (const [field, value] of Object.entries(snapshot)) {
          if (!isDeepStrictEqual(prior.snapshot[field], value)) addChange(field, prior.snapshot[field] ?? null, value ?? null);
        }
        if (prior.deletedAt !== deletedAt) addChange('deletedAt', prior.deletedAt, deletedAt);
      }
      return { ...Object.fromEntries(Object.entries(columns).map(([property, column]) => [column, snapshot[property]])),
        org_id: request.orgId, profile_id: request.profileId, amazon_id: row.amazonId,
        deleted_at: deletedAt, synced_at: current ? request.readStartedAt : prior!.syncedAt,
        [head]: controlObservedAt, ...(campaign ? { bidding_control_state: invalidate ? null : prior?.completeControls ?? null } : {}) };
    });
    if (!campaign) {
      const [precision] = await sql<{ valid: boolean }[]>`
        select coalesce(bool_and(bid is null or (bid >= 0 and bid = bid::numeric(12,4))), true) as valid
        from jsonb_to_recordset(${JSON.stringify(rows)}::text::jsonb) as row(bid numeric)`;
      if (!precision?.valid) throw new Error('control mirror bid exceeds storage precision');
    }
    if (rows.length > 0) {
      const writable = [...Object.values(columns), 'synced_at', 'deleted_at', head,
        ...(campaign ? ['bidding_control_state'] : [])];
      const updated = await sql.unsafe(`update public.${table} t set
        ${writable.map((column) => `${column} = row.${column}`).join(', ')}
        from jsonb_populate_recordset(null::public.${table}, $1::jsonb) row
        where t.org_id=$2::uuid and t.profile_id=$3::uuid and t.amazon_id=row.amazon_id returning t.amazon_id`,
      [JSON.stringify(rows), request.orgId, request.profileId]);
      const newRows = rows.filter((row) => !byId.has(row.amazon_id));
      const insertColumns = ['org_id', 'profile_id', ...writable];
      const inserted = await sql.unsafe(`insert into public.${table} (${insertColumns.join(', ')})
        select ${insertColumns.map((column) => `row.${column}`).join(', ')}
        from jsonb_populate_recordset(null::public.${table}, $1::jsonb) row
        on conflict (profile_id, amazon_id) do nothing returning amazon_id`, [JSON.stringify(newRows)]);
      counts.upserted = updated.length + inserted.length;
    }
    const missing = request.full ? existing.filter((row) => row.deletedAt === null && !seen.has(row.amazonId)
      && (request.adProduct === undefined || row.snapshot['adProduct'] === request.adProduct)) : [];
    counts.tombstonesOffered = missing.length;
    const currentMissing = missing.filter((row) => row.controlCurrent && row.entityCurrent);
    counts.staleTombstones = missing.length - currentMissing.length;
    if (currentMissing.length > 0) {
      const written = await sql.unsafe(`update public.${table} set deleted_at=$3::timestamptz,
        synced_at=$3::timestamptz, ${head}=$3::timestamptz ${campaign ? ', bidding_control_state=null' : ''}
        where org_id=$1::uuid and profile_id=$2::uuid and amazon_id=any($4::text[]) returning amazon_id`,
      [request.orgId, request.profileId, request.readStartedAt, currentMissing.map((row) => row.amazonId)]);
      counts.tombstoned = written.length;
      counts.invalidatedCompleteControls += currentMissing.filter((row) => row.completeControls != null).length;
      for (const row of currentMissing) changes.push({ amazonId: row.amazonId, entityName: row.snapshot['name'] ?? null,
        field: 'deletedAt', oldValue: null, newValue: request.readStartedAt });
    }
    if (changes.length > 0) {
      const written = await sql`insert into public.entity_changes
        (org_id, profile_id, entity_type, amazon_id, entity_name, field, old_value, new_value, source, observed_at)
        select ${request.orgId}::uuid, ${request.profileId}::uuid, ${request.entityType}::public.entity_type,
          "amazonId", "entityName", field, "oldValue", "newValue", 'sync', ${request.readStartedAt}::timestamptz
        from jsonb_to_recordset(${JSON.stringify(changes)}::text::jsonb) as row(
          "amazonId" text, "entityName" text, field text, "oldValue" jsonb, "newValue" jsonb) returning id`;
      counts.changes = written.length;
      if (counts.changes !== changes.length) throw new Error('control mirror diff count does not close');
    }
    await sql`select set_config(${contextKey}, ${window.previous ?? ''}, true)`;
    return ControlMirrorMergeCounts.parse(counts);
  });
}
