import type { ClaimedJob } from './job-wire.js';
import {
  ProviderGraphScope, ProviderGraphObservation, ProviderGraphAssociation, ProviderGraphReadResult,
  StreamExtensionBinding, StreamExtensionEvent, StreamExtensionEvidence,
  StreamExtensionReceipt, StreamExtensionDataset, StreamExtensionHealth, StreamConsumerSource, StreamBudgetHandoff, type StreamExtensionRefusal,
} from '@wizard-ads/shared';
import type { DbHandle, QueryHandle } from '../client.js';
import { appendProviderGraphEvidence, readProviderGraphEvidence } from './provider-graph.js';

/** Binding resolution uses a trusted transport destination, never event-supplied tenant IDs. */
export async function resolveStreamExtensionBinding(handle: QueryHandle, subscriptionId: string, destinationArn: string) {
  const rows = await handle.sql<{ binding: unknown; enabled: boolean; confirmed: boolean; capability_verified: boolean }[]>`
    select binding,enabled,confirmed,capability_verified from public.marketing_stream_extension_bindings
    where subscription_id=${subscriptionId} and destination_arn=${destinationArn}`;
  if (rows.length !== 1) return null;
  return StreamExtensionBinding.parse({ ...StreamExtensionBinding.parse(rows[0]!.binding),
    enabled: rows[0]!.enabled, confirmed: rows[0]!.confirmed, capabilityVerified: rows[0]!.capability_verified });
}

/** One transaction owns immutable events, independently read receipts and durable work. */
export async function retainStreamExtensionDelivery(handle: Pick<DbHandle, 'sql'>, input: {
  deliveryId: string; bodyFingerprint: string; receivedAt: string; decoded: number;
  event: StreamExtensionEvent | null; reason: StreamExtensionRefusal | null;
}): Promise<StreamExtensionReceipt> {
  const event = input.event === null ? null : StreamExtensionEvent.parse(input.event);
  if ((event === null) === (input.reason === null) || ![0, 1].includes(input.decoded)
    || (input.decoded === 0 && input.reason !== 'invalid_json') || (event !== null && input.decoded !== 1))
    throw new Error('Stream intake disposition does not explain its decoded row');
  return handle.sql.begin(async (sql) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${input.deliveryId},0))`;
    const prior = await sql<{ receipt: unknown; body_fingerprint: string }[]>`
      select receipt,body_fingerprint from public.marketing_stream_extension_receipts where delivery_id=${input.deliveryId}`;
    if (prior.length) {
      if (prior[0]!.body_fingerprint !== input.bodyFingerprint) throw new Error('Stream delivery identity conflict');
      return StreamExtensionReceipt.parse(prior[0]!.receipt);
    }
    let stored = 0;
    let duplicate = 0;
    let reason = input.reason;
    if (event) {
      const r = event.record;
      const key = 'entityId' in r.observation ? `${r.observation.adProduct}:${r.observation.entityId}`
        : 'recommendationId' in r.observation ? r.observation.recommendationId
          : `${r.observation.campaignId}:${r.observation.creativeId}:${r.window?.start}:${r.window?.end}`;
      const inserted = await sql`insert into public.marketing_stream_extension_events
        (org_id,profile_id,identity,dataset_id,entity_key,event_time,revision,payload_fingerprint,event,received_at,expires_at)
        values (${event.orgId},${event.profileId},${event.identity},${r.datasetId},${key},${r.eventTime},${r.revision},
          ${event.payloadFingerprint},${JSON.stringify(event)}::jsonb,${event.receivedAt},${event.receivedAt}::timestamptz+interval '95 days')
        on conflict do nothing returning identity`;
      const verified = await sql<{ payload_fingerprint: string }[]>`select payload_fingerprint
        from public.marketing_stream_extension_events where org_id=${event.orgId} and profile_id=${event.profileId} and identity=${event.identity}`;
      if (verified.length !== 1) throw new Error('Stream durable readback count mismatch');
      if (verified[0]!.payload_fingerprint !== event.payloadFingerprint) reason = 'revision_conflict';
      else {
        stored = inserted.length; duplicate = 1 - stored;
        await sql`insert into public.marketing_stream_extension_projections(org_id,profile_id,identity)
          values(${event.orgId},${event.profileId},${event.identity}) on conflict do nothing`;
        const payload = { type: 'marketing_stream.extensions.project', orgId: event.orgId, profileId: event.profileId,
          datasetId: r.datasetId, eventIdentity: event.identity };
        await sql`insert into public.sync_jobs(org_id,profile_id,job_type,payload,dedupe_key,run_after)
          values(${event.orgId},${event.profileId},'marketing_stream.extensions.project',${JSON.stringify(payload)}::jsonb,
            ${'stream-extension:' + event.identity},now()) on conflict do nothing`;
      }
    }
    const accepted = stored + duplicate;
    const receipt = StreamExtensionReceipt.parse({ deliveryId: input.deliveryId, bodyFingerprint: input.bodyFingerprint,
      receivedAt: input.receivedAt, outcome: reason === null ? 'accepted' : 'rejected', reason,
      counts: { received: 1, undecodable: input.decoded === 0 ? 1 : 0, decoded: input.decoded, accepted, stored, deduplicated: duplicate,
        rejected: input.decoded - accepted, deadLettered: 0, verifiedStored: accepted } });
    await sql`insert into public.marketing_stream_extension_receipts(delivery_id,body_fingerprint,received_at,receipt,expires_at,org_id,profile_id,dataset_id)
      values(${receipt.deliveryId},${receipt.bodyFingerprint},${receipt.receivedAt},${JSON.stringify(receipt)}::jsonb,
        ${receipt.receivedAt}::timestamptz+interval '95 days',${event?.orgId ?? null},${event?.profileId ?? null},${event?.record.datasetId ?? null})`;
    const check = await sql<{ receipt: unknown }[]>`select receipt from public.marketing_stream_extension_receipts where delivery_id=${receipt.deliveryId}`;
    if (check.length !== 1 || JSON.stringify(StreamExtensionReceipt.parse(check[0]!.receipt)) !== JSON.stringify(receipt))
      throw new Error('Stream receipt readback mismatch');
    return receipt;
  });
}

export async function markStreamExtensionDeadLetter(handle: QueryHandle, deliveryId: string, observedAt: string) {
  const rows = await handle.sql`update public.marketing_stream_extension_receipts set dead_lettered_at=${observedAt}, receipt=jsonb_set(receipt,'{counts,deadLettered}','1'::jsonb)
    where delivery_id=${deliveryId} and dead_lettered_at is null returning delivery_id`;
  const check = await handle.sql`select delivery_id from public.marketing_stream_extension_receipts
    where delivery_id=${deliveryId} and dead_lettered_at is not null`;
  if (check.length !== 1) throw new Error('Dead-letter observation has no durable delivery');
  return { observed: 1, written: rows.length, existing: 1 - rows.length, verified: check.length };
}

export async function projectStreamExtensionEvent(handle: Pick<DbHandle, 'sql'>, input: {
  orgId: string; profileId: string; datasetId: StreamExtensionDataset; eventIdentity: string;
}) {
  return handle.sql.begin(async (sql) => {
    const rows = await sql<{ event: unknown }[]>`select event from public.marketing_stream_extension_events
      where org_id=${input.orgId} and profile_id=${input.profileId} and identity=${input.eventIdentity} and dataset_id=${input.datasetId}`;
    if (rows.length !== 1) throw new Error('Stream projection needs one durable event');
    const event = StreamExtensionEvent.parse(rows[0]!.event);
    const record = event.record;
    const blocked = false;
    let graphScope: ProviderGraphScope | null = null;
    let graphReceipt: Awaited<ReturnType<typeof appendProviderGraphEvidence>> | null = null;
    if ('entityId' in record.observation) {
      const profiles = await sql<{ amazon_profile_id: string; region: string }[]>`
        select amazon_profile_id,region from public.ad_profiles where org_id=${event.orgId} and id=${event.profileId}`;
      if (profiles.length !== 1 || profiles[0]!.region !== record.region) throw new Error('Stream graph profile/region binding mismatch');
      graphScope = ProviderGraphScope.parse({ orgId: event.orgId, profileId: event.profileId,
        amazonProfileId: profiles[0]!.amazon_profile_id, region: profiles[0]!.region });
      const observed = record.observation;
      const kind = record.datasetId === 'ads-campaign-management-campaigns' ? 'campaign'
        : record.datasetId === 'ads-campaign-management-adgroups' ? 'ad_group'
          : record.datasetId === 'ads-campaign-management-ads' ? 'ad' : 'target';
      const node = ProviderGraphObservation.parse({ scope: graphScope,
        identity: { adProduct: observed.adProduct, kind, providerId: observed.entityId, version: null },
        source: 'marketing_stream', contractVersion: record.contractVersion, sourceEventAt: record.eventTime,
        observedAt: event.receivedAt, revision: String(record.revision), payloadFingerprint: event.payloadFingerprint,
        operation: observed.operation === 'tombstone' ? 'tombstone' : 'upsert', state: observed.state ?? 'unknown' });
      const associations: ProviderGraphAssociation[] = [];
      const addEdge = (targetKind: ProviderGraphObservation['identity']['kind'], providerId: string,
        relation: ProviderGraphAssociation['relation'], version: string | null = null) => {
        associations.push(ProviderGraphAssociation.parse({ scope: graphScope, from: node.identity,
          to: { adProduct: observed.adProduct, kind: targetKind, providerId, version }, relation,
          sourceEventAt: record.eventTime, revision: String(record.revision), payloadFingerprint: event.payloadFingerprint,
          operation: node.operation }));
      };
      if ('campaignId' in observed) addEdge('campaign', observed.campaignId, 'parent');
      if ('adGroupId' in observed) addEdge('ad_group', observed.adGroupId, 'parent');
      if ('assetId' in observed && observed.assetId !== undefined && observed.assetVersion !== undefined)
        addEdge('asset', observed.assetId, 'asset', observed.assetVersion);
      if ('asin' in observed && observed.asin !== undefined) addEdge('product', observed.asin, 'advertised_product');
      graphReceipt = await appendProviderGraphEvidence({ sql }, graphScope, ProviderGraphReadResult.parse({
        observations: [node], associations, sourceRows: 1, parsed: 1, refusals: [], pages: 1, completeness: 'partial' }));
    }
    await sql`update public.marketing_stream_extension_projections set status=${blocked ? 'blocked' : 'projected'},
      reason=${blocked ? 'wp312_provider_contract_missing' : null}, retry_after=null
      where org_id=${input.orgId} and profile_id=${input.profileId} and identity=${input.eventIdentity}`;
    const verified = await sql`select identity from public.marketing_stream_extension_projections
      where org_id=${input.orgId} and profile_id=${input.profileId} and identity=${input.eventIdentity}
        and status=${blocked ? 'blocked' : 'projected'}`;
    if (verified.length !== 1) throw new Error('Projection checkpoint readback mismatch');
    const persisted = await sql`select identity from public.marketing_stream_extension_events
      where org_id=${input.orgId} and profile_id=${input.profileId} and identity=${input.eventIdentity}
        and payload_fingerprint=${event.payloadFingerprint}`;
    if (persisted.length !== 1) throw new Error('Projected source fact readback mismatch');
    // One Stream event remains one coverage row; node and edge fan-out have separate counted receipts.
    return { event, blocked, graphScope, graphReceipt, sourceRows: 1, parsedRows: 1, refusedRows: 0,
      loadedRows: 1, verifiedLoadedRows: persisted.length };
  });
}

/** Source evidence is never complete inventory or approval authority. Receipt time never renews age. */
export async function readStreamExtensionEvidence(handle: QueryHandle, input: {
  orgId: string; profileId: string; datasetId: StreamExtensionDataset; asOf: string; maxAgeMs: number;
}): Promise<StreamExtensionEvidence> {
  if (!Number.isFinite(input.maxAgeMs) || input.maxAgeMs <= 0 || !Number.isFinite(Date.parse(input.asOf))) throw new Error('Invalid evidence window');
  const rows = await handle.sql<{ entity_key: string; event: unknown }[]>`select e.entity_key,e.event
    from public.marketing_stream_extension_events e join public.marketing_stream_extension_projections p
    on p.org_id=e.org_id and p.profile_id=e.profile_id and p.identity=e.identity
    where e.org_id=${input.orgId} and e.profile_id=${input.profileId} and e.dataset_id=${input.datasetId}
      and e.event_time<=${input.asOf} and e.received_at<=${input.asOf} and e.expires_at>${input.asOf} and p.status='projected'
    order by e.entity_key,e.event_time desc,e.revision desc,e.identity`;
  const groups = new Map<string, StreamExtensionEvent[]>();
  for (const row of rows) { const group = groups.get(row.entity_key) ?? []; group.push(StreamExtensionEvent.parse(row.event)); groups.set(row.entity_key, group); }
  const events = [...groups.values()].flatMap((group) => {
    const latest = group[0]!;
    const sameVersion = group.filter((e) => e.record.eventTime === latest.record.eventTime && e.record.revision === latest.record.revision);
    return new Set(sameVersion.map((e) => e.payloadFingerprint)).size === 1 ? [latest] : [];
  });
  return StreamExtensionEvidence.parse({ events, count: events.length, source: 'amazon_marketing_stream', selectionAuthority: false,
    completeness: events.length === 0 ? 'missing' : events.every((e) => Date.parse(input.asOf) - Date.parse(e.record.eventTime) > input.maxAgeMs) ? 'stale' : 'partial' });
}

export async function readStreamExtensionHealth(handle: QueryHandle, orgId: string, profileId: string): Promise<StreamExtensionHealth[]> {
  const bindings = await handle.sql<{ dataset_id: StreamExtensionDataset; enabled: boolean; confirmed: boolean }[]>`
    select dataset_id,enabled,confirmed from public.marketing_stream_extension_bindings
    where org_id=${orgId} and profile_id=${profileId}`;
  const rows = await handle.sql<{ dataset_id: StreamExtensionDataset; stored: number; latest_event_at: string | null; maximum_lag: number | null }[]>`
    select dataset_id,count(*)::int as stored,max(event_time)::text as latest_event_at,
      extract(epoch from max(received_at-event_time))::float as maximum_lag from public.marketing_stream_extension_events
    where org_id=${orgId} and profile_id=${profileId} group by dataset_id`;
  const counters=await handle.sql<{dataset_id:string;duplicates:number;rejected:number;dead_lettered:number}[]>`select * from app.stream_extension_receipt_counts(${orgId},${profileId})`;
  return StreamExtensionDataset.options.map((datasetId) => {
    const matches = bindings.filter((b) => b.dataset_id === datasetId);
    const row = rows.find((r) => r.dataset_id === datasetId);
    const counter=counters.find(r=>r.dataset_id===datasetId);
    return StreamExtensionHealth.parse({ datasetId, bindingCount: matches.length,
      enabled: matches.some((b) => b.enabled), confirmed: matches.length > 0 && matches.every((b) => b.confirmed),
      stored: row?.stored ?? 0, latestEventAt: row?.latest_event_at ? new Date(row.latest_event_at).toISOString() : null,
      maximumLagSeconds: row?.maximum_lag ?? null, duplicates: counter?.duplicates ?? null, rejected: counter?.rejected ?? null, deadLettered: counter?.dead_lettered ?? null });
  });
}

/** Read-only WP-292 handoff. Recommendations never become observed usage or approval. */
export async function readStreamBudgetHandoff(handle: QueryHandle, input: Parameters<typeof readStreamExtensionEvidence>[1]) {
  const evidence = await readStreamExtensionEvidence(handle, { ...input, datasetId: 'sp-budget-recommendations' });
  return evidence.events.map((event) => StreamBudgetHandoff.parse({ event, transport: 'marketing_stream',
    kind: 'provider_budget_recommendation', observedUsage: null, approvalAuthority: false }));
}

export async function readStreamConsumerSource(handle: QueryHandle, input: {
  orgId: string; profileId: string; datasets: readonly StreamExtensionDataset[];
  asOf: string; maxAgeMs: number; from?: string; to?: string; campaignId?: string | null;
  assetId?: string | null; entityId?: string | null; asin?: string | null; history?: boolean;
}): Promise<StreamConsumerSource> {
  let events: StreamExtensionEvent[] = [];
  let truncated = false;
  if (input.history) {
    const rows = await handle.sql<{ event: unknown }[]>`select e.event from public.marketing_stream_extension_events e
      join public.marketing_stream_extension_projections p using(org_id,profile_id,identity)
      where e.org_id=${input.orgId} and e.profile_id=${input.profileId} and e.dataset_id=any(${[...input.datasets]})
        and p.status='projected' and e.event_time<=${input.asOf} and e.received_at<=${input.asOf} and e.expires_at>${input.asOf}
        and (${input.from ?? null}::timestamptz is null or e.event_time>=${input.from ?? null}::timestamptz)
        and (${input.to ?? null}::timestamptz is null or e.event_time<${input.to ?? null}::timestamptz)
      order by e.event_time desc,e.revision desc,e.identity limit 501`;
    truncated = rows.length > 500;
    events = rows.slice(0,500).map((row) => StreamExtensionEvent.parse(row.event));
  } else {
    for (const datasetId of input.datasets) events.push(...(await readStreamExtensionEvidence(handle, { ...input, datasetId })).events);
  }
  const [profile] = await handle.sql<{ amazon_profile_id: string; region: string }[]>`select amazon_profile_id,region from public.ad_profiles
    where org_id=${input.orgId} and id=${input.profileId}`;
  if (!profile) throw new Error('Stream reader profile missing');
  const scope = ProviderGraphScope.parse({ orgId: input.orgId, profileId: input.profileId,
    amazonProfileId: profile.amazon_profile_id, region: profile.region });
  return StreamConsumerSource.parse({ events, scope, truncated, graph: await readProviderGraphEvidence(handle,scope,input.asOf) });
}

/** Retry source accounting follows existing queue custody, capped across replacement jobs. */
export async function beginStreamProjectionAttempt(handle: Pick<DbHandle, 'sql'>, input: {
  orgId: string; profileId: string; eventIdentity: string;
}, job: ClaimedJob) {
  return handle.sql.begin(async (sql) => {
    const custody = await sql`select id from public.sync_jobs where id=${job.id} and org_id=${input.orgId} and profile_id=${input.profileId}
      and status='running' and claimed_by=${job.claimedBy} and attempts=${job.attempts}
      and claim_token is not distinct from ${job.claim?.token ?? null}::uuid for update`;
    if(custody.length!==1) throw new Error('Stream queue custody lost');
    const [row] = await sql<{event:unknown;status:string;attempts:number;retry_after:string|null;last_attempt_key:string|null}[]>`
      select e.event,p.status,p.attempts,p.retry_after::text,p.last_attempt_key from public.marketing_stream_extension_events e
      join public.marketing_stream_extension_projections p using(org_id,profile_id,identity)
      where e.org_id=${input.orgId} and e.profile_id=${input.profileId} and e.identity=${input.eventIdentity} for update of p`;
    if(!row) throw new Error('Stream checkpoint missing');
    const event=StreamExtensionEvent.parse(row.event),r=event.record;
    const binding=await resolveStreamExtensionBinding({sql},r.subscriptionId,r.destinationArn);
    if(!binding || !binding.enabled || !binding.confirmed || !binding.capabilityVerified
      || binding.orgId!==input.orgId || binding.profileId!==input.profileId
      || ['datasetId','advertiserId','marketplaceId','region','destinationArn','contractVersion'].some(k=>Reflect.get(binding,k)!==Reflect.get(r,k))) {
      await sql`update public.marketing_stream_extension_projections set status='blocked',reason='binding_refused'
        where org_id=${input.orgId} and profile_id=${input.profileId} and identity=${input.eventIdentity}`;
      return {kind:'refused' as const};
    }
    if(row.status==='projected') return {kind:'ready' as const};
    if(row.retry_after && Date.parse(row.retry_after)>Date.now()) return {kind:'deferred' as const,retryAt:new Date(row.retry_after).toISOString()};
    const key=job.id+':'+job.attempts;
    if(row.last_attempt_key===key) return {kind:'ready' as const};
    if(row.attempts>=8) return {kind:'refused' as const};
    await sql`update public.marketing_stream_extension_projections set attempts=attempts+1,status='retrying',last_attempt_key=${key}
      where org_id=${input.orgId} and profile_id=${input.profileId} and identity=${input.eventIdentity}`;
    return {kind:'ready' as const};
  });
}
export async function failStreamProjectionAttempt(handle: Pick<DbHandle, 'sql'>, input: {
  orgId: string; profileId: string; eventIdentity: string;
}) {
  await handle.sql`update public.marketing_stream_extension_projections
    set status=case when attempts>=8 then 'blocked' else 'retrying' end,
      reason=case when attempts>=8 then 'retry_exhausted' else 'projection_failed' end,
      retry_after=now()+least(3600,power(2,attempts)::int*30)*interval '1 second'
    where org_id=${input.orgId} and profile_id=${input.profileId} and identity=${input.eventIdentity}`;
}

/** Startup repairs missing/dead work; active queue claims remain owned by its existing reaper. */
export async function reconcileStreamExtensionWork(handle: Pick<DbHandle, 'sql'>, enabled = false, limit = 100) {
  const counts = { requested: 0, attempted: 0, succeeded: 0, failed: 0, refused: 0 };
  if (!enabled) return counts;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid Stream reconciliation bound');
  await handle.sql.begin(async (sql) => {
    const rows = await sql<{ org_id: string; profile_id: string; identity: string; dataset_id: StreamExtensionDataset; attempts: number; queue_attempts: number; admitted: boolean }[]>`
      select p.org_id,p.profile_id,p.identity,e.dataset_id,p.attempts,
        (select coalesce(sum(greatest(j.attempts,1)),0)::int from public.sync_jobs j
          where j.org_id=p.org_id and j.profile_id=p.profile_id and j.job_type='marketing_stream.extensions.project'
            and j.payload->>'eventIdentity'=p.identity) as queue_attempts,
        exists(select 1 from public.marketing_stream_extension_bindings b where b.org_id=p.org_id and b.profile_id=p.profile_id
          and b.dataset_id=e.dataset_id and b.subscription_id=e.event #>> '{record,subscriptionId}'
          and b.enabled and b.confirmed and b.capability_verified) as admitted
      from public.marketing_stream_extension_projections p join public.marketing_stream_extension_events e using(org_id,profile_id,identity)
      where p.status in ('pending','retrying','projected') and (p.retry_after is null or p.retry_after<=now()) and e.expires_at>now()
        and not exists(select 1 from public.sync_jobs j where j.org_id=p.org_id and j.profile_id=p.profile_id
          and j.job_type='marketing_stream.extensions.project' and j.payload->>'eventIdentity'=p.identity and j.status in ('queued','running'))
        and not exists(select 1 from public.sync_jobs done where done.org_id=p.org_id and done.profile_id=p.profile_id
          and done.job_type='marketing_stream.extensions.project' and done.payload->>'eventIdentity'=p.identity and done.status='succeeded')
      order by e.received_at limit ${limit} for update of p skip locked`;
    for (const row of rows) {
      counts.requested++;
      if (!row.admitted || row.attempts >= 8 || row.queue_attempts >= 8) { counts.refused++; continue; }
      counts.attempted++;
      const key = `stream-recovery:${row.identity}:${row.queue_attempts}`;
      const payload = { type: 'marketing_stream.extensions.project', orgId: row.org_id, profileId: row.profile_id,
        datasetId: row.dataset_id, eventIdentity: row.identity };
      await sql`insert into public.sync_jobs(org_id,profile_id,job_type,payload,dedupe_key,max_attempts)
        values(${row.org_id},${row.profile_id},'marketing_stream.extensions.project',${JSON.stringify(payload)}::jsonb,${key},${8-Math.max(row.attempts,row.queue_attempts)}) on conflict do nothing`;
      const check = await sql`select id from public.sync_jobs where org_id=${row.org_id} and profile_id=${row.profile_id} and dedupe_key=${key} and status in ('queued','running')`;
      if (check.length !== 1) throw new Error('Stream recovery queue readback mismatch');
      counts.succeeded++;
    }
  });
  return counts;
}
