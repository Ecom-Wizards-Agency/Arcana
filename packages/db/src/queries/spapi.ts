import {
  SpApiConnectionBegin, SpApiConnectionSubmit, SpApiConnectionOperation, SpApiConnectionClaim, SpApiAttachmentContext, Uuid,
  SpApiBindingReportingRequest, SpApiProfileBindingState,
  type ProviderConnectionLifecycle, type OrgActor, type SpApiConsentRefusal,
} from '@wizard-ads/shared';
import { withAuthenticatedActor, AgencyAccessDenied } from './authenticated-actor.js';
import { providerConnectionHealth } from './connections.js';
/**
 * SP-API authorization metadata and weekly SQP scheduling inputs.
 *
 * Credential values cross only the three service-role Vault RPCs. Every
 * metadata query is explicitly org-scoped even though the worker handle uses
 * the service role and therefore bypasses RLS.
 */
import type { Region } from '@wizard-ads/shared';
import type { DbHandle, QueryHandle, QuerySql } from '../client.js';

export interface SpApiConnectionRecord {
  id: string;
  orgId: string;
  label: string;
  sellingPartnerId: string | null;
  marketplaceIds: string[];
  status: 'pending' | 'active' | 'revoked' | 'error';
  hasCredential: boolean;
}

export interface ActiveSpApiProfileBinding {
  orgId: string;
  profileId: string;
  connectionId: string;
  marketplaceId: string;
  region: Region;
  timezone: string;
}

export interface SqpScheduleScope extends ActiveSpApiProfileBinding {
  asins: string[];
  sourceRows: number;
  duplicateRows: number;
  refusedRows: number;
}

type SpApiConnectionRow = {
  id: string;
  org_id: string;
  label: string;
  selling_partner_id: string | null;
  marketplace_ids: string[];
  status: SpApiConnectionRecord['status'];
  has_credential: boolean;
};

function toConnection(row: SpApiConnectionRow): SpApiConnectionRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    label: row.label,
    sellingPartnerId: row.selling_partner_id,
    marketplaceIds: row.marketplace_ids,
    status: row.status,
    hasCredential: row.has_credential,
  };
}

function normalizeMarketplaceIds(values: readonly string[]): string[] {
  const normalized = [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
  if (normalized.length === 0 || normalized.some((value) => value.length > 64)) {
    throw new Error('An SP-API connection requires valid marketplace ids');
  }
  return normalized;
}

/** Insert metadata or read an identical scope. A reconnect never rewrites active scope. */
export async function createSpApiConnection(
  handle: QueryHandle,
  input: {
    /** Reserved by the locked consent operation for atomic onboarding. */
    connectionId?: string;
    orgId: string;
    label: string;
    sellingPartnerId?: string | null;
    marketplaceIds: readonly string[];
  },
): Promise<SpApiConnectionRecord> {
  const label = input.label.trim();
  if (!label) throw new Error('An SP-API connection label cannot be empty');
  const marketplaceIds = normalizeMarketplaceIds(input.marketplaceIds);
  const rows = await handle.sql<SpApiConnectionRow[]>`
    with inserted as (insert into public.spapi_connections
      (id, org_id, label, selling_partner_id, marketplace_ids, status)
    values
      (coalesce(${input.connectionId ?? null}::uuid, gen_random_uuid()), ${input.orgId}, ${label}, ${input.sellingPartnerId?.trim() || null}, ${marketplaceIds}, 'pending')
    on conflict (org_id, label) do nothing
    returning id, org_id, label, selling_partner_id, marketplace_ids,
              status::text as status, (vault_secret_id is not null) as has_credential)
    select * from inserted
    union all
    select id, org_id, label, selling_partner_id, marketplace_ids, status::text, (vault_secret_id is not null)
      from public.spapi_connections where org_id = ${input.orgId} and label = ${label}
      and not exists (select 1 from inserted)
  `;
  const row = rows[0];
  if (rows.length !== 1 || !row || (input.connectionId !== undefined && row.id !== input.connectionId)
    || row.selling_partner_id !== (input.sellingPartnerId?.trim() || null)
    || JSON.stringify([...row.marketplace_ids].sort()) !== JSON.stringify(marketplaceIds)) {
    throw new Error('SP-API connection metadata conflicts with the requested scope');
  }
  return toConnection(row);
}

/** Assign one profile atomically; the migration rejects cross-org/mismatched marketplaces. */
export async function upsertSpApiProfileBinding(
  handle: QueryHandle,
  input: {
    orgId: string;
    profileId: string;
    connectionId: string;
    marketplaceId: string;
    enabled?: boolean;
  },
): Promise<ActiveSpApiProfileBinding & { enabled: boolean }> {
  const marketplaceId = input.marketplaceId.trim();
  if (!marketplaceId) throw new Error('An SP-API profile binding requires a marketplace id');
  const rows = await handle.sql<Array<{
    org_id: string;
    profile_id: string;
    connection_id: string;
    marketplace_id: string;
    enabled: boolean;
    region: Region;
    timezone: string;
  }>>`
    with bound as (
      insert into public.spapi_profile_bindings
        (org_id, profile_id, connection_id, marketplace_id, enabled)
      values
        (${input.orgId}, ${input.profileId}, ${input.connectionId}, ${marketplaceId}, ${input.enabled ?? false})
      on conflict (profile_id) do update
        set connection_id = excluded.connection_id,
            marketplace_id = excluded.marketplace_id,
            enabled = excluded.enabled
      where spapi_profile_bindings.org_id = excluded.org_id
        and spapi_profile_bindings.connection_id = excluded.connection_id
        and spapi_profile_bindings.marketplace_id = excluded.marketplace_id
      returning org_id, profile_id, connection_id, marketplace_id, enabled
    )
    select b.org_id, b.profile_id, b.connection_id, b.marketplace_id, b.enabled,
           p.region::text as region, p.timezone
      from bound b
      join public.ad_profiles p on p.id = b.profile_id and p.org_id = b.org_id
  `;
  const row = rows[0];
  if (!row) throw new Error('Assigning the SP-API profile binding returned no row');
  return {
    orgId: row.org_id,
    profileId: row.profile_id,
    connectionId: row.connection_id,
    marketplaceId: row.marketplace_id,
    region: row.region,
    timezone: row.timezone,
    enabled: row.enabled,
  };
}

export class SpApiCredentialStoreError extends Error {
  constructor() {
    super('The SP-API credential could not be stored');
    this.name = 'SpApiCredentialStoreError';
  }
}

/** Store or rotate the refresh credential without allowing it onto a query error. */
export async function storeSpApiRefreshToken(
  handle: Pick<DbHandle, 'sql'>,
  input: { orgId: string; connectionId: string; refreshToken: string },
): Promise<string> {
  let rows: Array<{ secret_id: string }>;
  try {
    rows = await handle.sql<Array<{ secret_id: string }>>`
      select public.store_spapi_refresh_token(c.id, ${input.refreshToken}) as secret_id
        from public.spapi_connections c
       where c.org_id = ${input.orgId} and c.id = ${input.connectionId}
    `;
  } catch {
    throw new SpApiCredentialStoreError();
  }
  const secretId = rows[0]?.secret_id;
  if (!secretId) throw new Error('SP-API connection not found');
  return secretId;
}

/** Worker-only exact-org credential read. Null means missing, inactive, or mismatched. */
export async function getSpApiRefreshToken(
  handle: Pick<DbHandle, 'sql'>,
  input: { orgId: string; connectionId: string },
): Promise<string | null> {
  const rows = await handle.sql<Array<{ refresh_token: string | null }>>`
    select public.get_spapi_refresh_token(c.id) as refresh_token
      from public.spapi_connections c
     where c.org_id = ${input.orgId}
       and c.id = ${input.connectionId}
       and c.status = 'active'
       and c.vault_secret_id is not null
  `;
  return rows[0]?.refresh_token ?? null;
}

export async function revokeSpApiRefreshToken(
  handle: Pick<DbHandle, 'sql'>,
  input: { orgId: string; connectionId: string },
): Promise<boolean> {
  const rows = await handle.sql<Array<{ revoked: boolean }>>`
    select public.revoke_spapi_refresh_token(c.id) as revoked
      from public.spapi_connections c
     where c.org_id = ${input.orgId} and c.id = ${input.connectionId}
  `;
  return rows[0]?.revoked ?? false;
}

/** Re-check exact tenant/profile/marketplace ownership before every queued workflow. */
export async function resolveActiveSpApiProfileBinding(
  handle: Pick<DbHandle, 'sql'>,
  input: { orgId: string; profileId: string; marketplaceId: string },
): Promise<ActiveSpApiProfileBinding | null> {
  const rows = await handle.sql<Array<{
    org_id: string;
    profile_id: string;
    connection_id: string;
    marketplace_id: string;
    region: Region;
    timezone: string;
  }>>`
    select b.org_id, b.profile_id, b.connection_id, b.marketplace_id,
           p.region::text as region, p.timezone
      from public.spapi_profile_bindings b
      join public.ad_profiles p
        on p.id = b.profile_id and p.org_id = b.org_id
      join public.spapi_connections c
        on c.id = b.connection_id and c.org_id = b.org_id
     where b.org_id = ${input.orgId}
       and b.profile_id = ${input.profileId}
       and b.marketplace_id = ${input.marketplaceId}
       and b.enabled
       and p.sync_enabled
       and c.status = 'active'
       and c.vault_secret_id is not null
       and nullif(btrim(c.selling_partner_id), '') is not null
       and b.marketplace_id = any(c.marketplace_ids)
       and p.region = app.spapi_region_for_marketplace(b.marketplace_id)
  `;
  const row = rows[0];
  return row
    ? {
        orgId: row.org_id,
        profileId: row.profile_id,
        connectionId: row.connection_id,
        marketplaceId: row.marketplace_id,
        region: row.region,
        timezone: row.timezone,
      }
    : null;
}

/**
 * All enabled SQP scopes plus reconciled advertised-ASIN counts.
 *
 * `sourceRows = unique ASINs + duplicates + refused` is asserted after the SQL
 * boundary so an Amazon mirror shape change cannot silently shrink scheduling.
 */
export async function listSqpScheduleScopes(
  handle: Pick<DbHandle, 'sql'>,
): Promise<SqpScheduleScope[]> {
  const rows = await handle.sql<Array<{
    org_id: string;
    profile_id: string;
    connection_id: string;
    marketplace_id: string;
    region: Region;
    timezone: string;
    asins: string[];
    source_rows: string;
    valid_rows: string;
    refused_rows: string;
  }>>`
    select b.org_id, b.profile_id, b.connection_id, b.marketplace_id,
           p.region::text as region, p.timezone,
           coalesce(products.asins, array[]::text[]) as asins,
           coalesce(products.source_rows, 0)::text as source_rows,
           coalesce(products.valid_rows, 0)::text as valid_rows,
           coalesce(products.refused_rows, 0)::text as refused_rows
      from public.spapi_profile_bindings b
      join public.ad_profiles p
        on p.id = b.profile_id and p.org_id = b.org_id
      join public.spapi_connections c
        on c.id = b.connection_id and c.org_id = b.org_id
      left join lateral (
        select
          array_agg(distinct upper(btrim(pa.asin)) order by upper(btrim(pa.asin)))
            filter (where btrim(pa.asin) ~ '^[A-Za-z0-9]{10}$') as asins,
          count(*) as source_rows,
          count(*) filter (where btrim(pa.asin) ~ '^[A-Za-z0-9]{10}$') as valid_rows,
          count(*) filter (where pa.asin is null or btrim(pa.asin) !~ '^[A-Za-z0-9]{10}$') as refused_rows
        from public.product_ads pa
        where pa.org_id = b.org_id
          and pa.profile_id = b.profile_id
          and pa.deleted_at is null
      ) products on true
     where b.enabled
       and p.sync_enabled
       and c.status = 'active'
       and c.vault_secret_id is not null
       and nullif(btrim(c.selling_partner_id), '') is not null
       and b.marketplace_id = any(c.marketplace_ids)
       and p.region = app.spapi_region_for_marketplace(b.marketplace_id)
     order by b.org_id, b.profile_id
  `;

  return rows.map((row) => {
    const sourceRows = Number(row.source_rows);
    const validRows = Number(row.valid_rows);
    const refusedRows = Number(row.refused_rows);
    const duplicateRows = validRows - row.asins.length;
    if (
      !Number.isSafeInteger(sourceRows) || !Number.isSafeInteger(validRows) ||
      !Number.isSafeInteger(refusedRows) || duplicateRows < 0 ||
      sourceRows !== row.asins.length + duplicateRows + refusedRows
    ) {
      throw new Error('SP-API SQP scheduling ASIN counts do not reconcile');
    }
    return {
      orgId: row.org_id,
      profileId: row.profile_id,
      connectionId: row.connection_id,
      marketplaceId: row.marketplace_id,
      region: row.region,
      timezone: row.timezone,
      asins: row.asins,
      sourceRows,
      duplicateRows,
      refusedRows,
    };
  });
}

/** No bound code, refresh value, query parameters or raw cause escapes this boundary. */
export class SpApiConnectionCommandError extends Error {
  override readonly name = 'SpApiConnectionCommandError';
  constructor(readonly reason: SpApiConsentRefusal = 'submission_uncertain') { super('SP-API connection command could not be completed'); }
}

function consentRefusal(error: unknown): SpApiConsentRefusal {
  if (error instanceof AgencyAccessDenied) return 'authority_changed';
  const codes: Record<string, SpApiConsentRefusal> = {
    SC001: 'mismatch', SC002: 'expired', SC003: 'reused', SC004: 'wrong_actor',
    SC005: 'operation_not_pending', SC006: 'authority_changed', SC007: 'invalid_consent',
    '42501': 'authority_changed',
  };
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  return typeof code === 'string' && Object.hasOwn(codes, code)
    ? codes[code]! : 'submission_uncertain';
}

function spApiOperation(rows: { result: unknown }[]): SpApiConnectionOperation {
  if (rows.length !== 1) throw new SpApiConnectionCommandError();
  return SpApiConnectionOperation.parse(rows[0]!.result);
}

/** Bound custody commands; uncertain claims and attachments are never retried. */
async function spApiConnectionCommand<T>(handle: Pick<DbHandle, 'sql'>, run: (sql: QuerySql) => Promise<T>): Promise<T> {
  try {
    const result = await handle.sql.begin(async (sql) => {
      await sql`set local statement_timeout = '10s'`;
      await sql`set local lock_timeout = '3s'`;
      return { value: await run(sql) };
    });
    return result.value;
  } catch { throw new SpApiConnectionCommandError(); }
}

export function createSpApiConnectionLifecycle(
  handle: Pick<DbHandle, 'sql'>,
  enabled: () => boolean = () => false,
): ProviderConnectionLifecycle<SpApiConnectionBegin, SpApiConnectionSubmit, SpApiConnectionOperation, SpApiConnectionClaim> {
  const gate = (): void => { if (!enabled()) throw new Error('Provider connections are disabled'); };
  return {
    provider: 'amazon_spapi',
    begin: async (actor, raw) => {
      gate();
      const { requestId, nonceHash, ...installation } = SpApiConnectionBegin.parse(raw);
      return withAuthenticatedActor(handle, actor, async (sql) => spApiOperation(await sql<{ result: unknown }[]>`
        select app.begin_spapi_connection(${actor.orgId},${requestId},${nonceHash},${JSON.stringify(installation)}::jsonb) as result
      `));
    },
    submit: async (actor, raw) => {
      if (!enabled()) throw new SpApiConnectionCommandError('not_configured');
      const parsed = SpApiConnectionSubmit.safeParse(raw);
      if (!parsed.success) throw new SpApiConnectionCommandError('invalid_consent');
      try {
        const input = parsed.data;
        return await withAuthenticatedActor(handle, actor, async (sql) => spApiOperation(await sql<{ result: unknown }[]>`
          select app.submit_spapi_connection(${actor.orgId},${input.operationId},${input.nonceHash},${input.code},${input.sellingPartnerId}) as result
        `));
      } catch (error) { throw new SpApiConnectionCommandError(consentRefusal(error)); }
    },
    cancel: (actor, operationId) => {
      const id = Uuid.parse(operationId);
      return withAuthenticatedActor(handle, actor, async (sql) => spApiOperation(await sql<{ result: unknown }[]>`
        select app.cancel_spapi_connection(${actor.orgId},${id}) as result
      `));
    },
    operation: (actor, operationId) => {
      const id = Uuid.parse(operationId);
      return withAuthenticatedActor(handle, actor, async (sql) => {
        const rows = await sql<{ result: unknown }[]>`select app.read_spapi_connection(${actor.orgId},${id}) as result`;
        if (rows.length !== 1) throw new SpApiConnectionCommandError();
        return rows[0]!.result === null ? null : SpApiConnectionOperation.parse(rows[0]!.result);
      });
    },
    health: (actor, id) => providerConnectionHealth(handle, actor, 'amazon_spapi', id),
    revoke: (actor, id) => providerConnectionHealth(handle, actor, 'amazon_spapi', id, true),
    custody: {
      claim: async (leaseId) => {
        try {
          const lease = Uuid.parse(leaseId);
          return await spApiConnectionCommand(handle, async (sql) => {
            const rows = await sql<{ result: unknown }[]>`select app.claim_spapi_connection(${lease}) as result`;
            if (rows.length !== 1) throw new SpApiConnectionCommandError();
            return rows[0]!.result === null ? null : SpApiConnectionClaim.parse(rows[0]!.result);
          });
        } catch { throw new SpApiConnectionCommandError(); }
      },
      read: async (operationId) => {
        try {
          const id = Uuid.parse(operationId);
          return await spApiConnectionCommand(handle, async (sql) =>
            spApiOperation(await sql<{ result: unknown }[]>`select app.read_spapi_connection_worker(${id}) as result`));
        } catch { throw new SpApiConnectionCommandError(); }
      },
      attach: (id, lease, refresh) => settleSpApiConnection(handle, id, lease, { refresh }),
    },
  };
}

export async function settleSpApiConnection(
  handle: Pick<DbHandle, 'sql'>, operationId: string, leaseId: string,
  outcome: { refresh: string } | { reason: 'not_configured' | 'exchange_uncertain' | 'exchange_refused' },
): Promise<SpApiConnectionOperation> {
  try {
    const id = Uuid.parse(operationId); const lease = Uuid.parse(leaseId);
    const refresh = 'refresh' in outcome ? outcome.refresh : null;
    const reason = 'reason' in outcome ? outcome.reason : null;
    if (refresh !== null && (refresh.length === 0 || refresh.length > 65_536)) throw new SpApiConnectionCommandError();
    return await spApiConnectionCommand(handle, async (sql) => {
      if (refresh === null) return spApiOperation(await sql<{ result: unknown }[]>`
        select app.settle_spapi_connection(${id},${lease},${refresh},${reason}) as result
      `);
      const rows = await sql<{ result: unknown }[]>`select app.prepare_spapi_attachment(${id},${lease}) as result`;
      if (rows.length !== 1) throw new SpApiConnectionCommandError();
      if (rows[0]!.result === null) return spApiOperation(await sql<{ result: unknown }[]>`
        select app.read_spapi_connection_worker(${id}) as result
      `);
      const context = SpApiAttachmentContext.parse(rows[0]!.result);
      if (context.operation.operationId !== id || context.targetConnectionId === null) throw new SpApiConnectionCommandError();
      const { bindings, label } = context.installation;
      const connection = await createSpApiConnection({ sql }, {
        connectionId: context.targetConnectionId, orgId: context.operation.orgId, label,
        sellingPartnerId: context.sellingPartnerId, marketplaceIds: bindings.map((binding) => binding.marketplaceId),
      });
      // A reconnect re-attaches every binding with reporting off. Record each binding that had
      // reporting on, locked first so the prior state is the one this attachment replaces.
      const reportingBefore = await sql<{ id: string; marketplace_id: string }[]>`
        select id::text, marketplace_id from public.spapi_profile_bindings
         where org_id = ${context.operation.orgId} and connection_id = ${connection.id} and enabled
           and profile_id = any(${bindings.map((binding) => binding.profileId)}::uuid[])
         order by profile_id for update`;
      let attached = 0;
      for (const binding of bindings) {
        const saved = await upsertSpApiProfileBinding({ sql }, {
          orgId: context.operation.orgId, connectionId: connection.id, ...binding, enabled: false,
        });
        if (saved.profileId !== binding.profileId || saved.marketplaceId !== binding.marketplaceId
          || saved.connectionId !== connection.id || saved.orgId !== context.operation.orgId || saved.enabled) {
          throw new SpApiConnectionCommandError();
        }
        attached += 1;
      }
      if (reportingBefore.length > 0) {
        const audited = await sql<{ id: string }[]>`
          insert into public.audit_log(org_id,actor_type,actor_id,action,target_type,target_id,payload,source)
          select ${context.operation.orgId}::uuid,'service'::public.audit_actor_type,'connection-worker','spapi.binding_reporting_disabled',
                 'spapi_profile_binding',prior.id,
                 jsonb_build_object('connectionId',${connection.id}::text,'marketplaceId',prior.marketplace_id,'enabled',false,
                   'reason','reconnect','operationId',${id}::text),'worker'
            from unnest(${reportingBefore.map((row) => row.id)}::text[],${reportingBefore.map((row) => row.marketplace_id)}::text[])
              as prior(id,marketplace_id)
          returning id::text`;
        if (audited.length !== reportingBefore.length) throw new SpApiConnectionCommandError();
      }
      const completed = spApiOperation(await sql<{ result: unknown }[]>`
        select app.finish_spapi_attachment(${id},${lease},${connection.id},${refresh}) as result
      `);
      if (completed.state !== 'completed' || completed.connectionId !== connection.id
        || completed.requestedBindings !== bindings.length || completed.attachedBindings !== attached) {
        throw new SpApiConnectionCommandError();
      }
      return completed;
    });
  } catch { throw new SpApiConnectionCommandError(); }
}

export async function latestSpApiConnection(
  handle: Pick<DbHandle, 'sql'>, actor: OrgActor,
): Promise<SpApiConnectionOperation | null> {
  return withAuthenticatedActor(handle, actor, async (sql) => {
    const rows = await sql<{ result: unknown }[]>`select app.latest_spapi_connection(${actor.orgId}) as result`;
    return rows[0]?.result == null ? null : spApiOperation(rows);
  });
}

/** Every profile binding of the org with its saved reporting state, under the caller's RLS. */
export async function listSpApiProfileBindings(
  handle: QueryHandle, orgId: string,
): Promise<SpApiProfileBindingState[]> {
  const rows = await handle.sql<{ state: unknown }[]>`
    select jsonb_build_object('bindingId',b.id,'connectionId',b.connection_id,'profileId',b.profile_id,
      'profileName',left(coalesce(nullif(btrim(p.account_name),''),p.amazon_profile_id),512),'marketplaceId',b.marketplace_id,
      'enabled',b.enabled,'enabledAt',b.enabled_at,'profileSyncEnabled',p.sync_enabled) as state
      from public.spapi_profile_bindings b
      join public.ad_profiles p on p.id = b.profile_id and p.org_id = b.org_id
     where b.org_id = ${orgId}
     order by b.connection_id, b.created_at, b.id
  `;
  return rows.map((row) => SpApiProfileBindingState.parse(row.state));
}

/** A refused reporting change. Only fixed reasons cross this boundary. */
export class SpApiBindingReportingError extends Error {
  override readonly name = 'SpApiBindingReportingError';
  constructor(readonly reason: 'connection_inactive' | 'unconfirmed') { super('SP-API reporting change could not be completed'); }
}

/**
 * Switch weekly reporting for one binding of one connection. The database locks
 * owner/admin authority and writes the audit row; null means no such binding in
 * this org and connection. A role refusal surfaces as AgencyAccessDenied.
 */
export async function setSpApiBindingReporting(
  handle: Pick<DbHandle, 'sql'>, actor: OrgActor,
  input: { connectionId: string; bindingId: string } & SpApiBindingReportingRequest,
): Promise<SpApiProfileBindingState | null> {
  // Postgres returns lowercase; an uppercase id must not fail the readback after a commit.
  const connectionId = Uuid.parse(input.connectionId).toLowerCase();
  const bindingId = Uuid.parse(input.bindingId).toLowerCase();
  const { enabled } = SpApiBindingReportingRequest.parse({ enabled: input.enabled });
  let rows: { result: unknown }[];
  try {
    rows = await withAuthenticatedActor(handle, actor, (sql) => sql<{ result: unknown }[]>`
      select app.set_spapi_binding_reporting(${actor.orgId},${connectionId},${bindingId},${enabled}) as result
    `);
  } catch (error) {
    if (error instanceof AgencyAccessDenied) throw error;
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
    if (code === '42501') throw new AgencyAccessDenied();
    throw new SpApiBindingReportingError(code === '55000' ? 'connection_inactive' : 'unconfirmed');
  }
  if (rows.length !== 1) throw new SpApiBindingReportingError('unconfirmed');
  if (rows[0]!.result === null) return null;
  const state = SpApiProfileBindingState.parse(rows[0]!.result);
  if (state.bindingId !== bindingId || state.connectionId !== connectionId || state.enabled !== enabled) {
    throw new SpApiBindingReportingError('unconfirmed');
  }
  return state;
}
