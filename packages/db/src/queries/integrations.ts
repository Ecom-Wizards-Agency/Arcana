/**
 * External integration connection metadata and credential custody.
 *
 * Metadata helpers are always org-scoped because the web handle is the service
 * role and therefore bypasses RLS. Their public record exposes only whether a
 * credential exists, never the Vault pointer. The three RPC wrappers preserve
 * the database custody boundary used by workers and the one-time web write.
 */
import { INTEGRATION_PROVIDERS, ORG_CAPABILITY_ROLES, OrgActor, OrgRole, Uuid } from '@wizard-ads/shared';
import type postgres from 'postgres';
import type { DbHandle, QueryHandle } from '../client.js';
import type { connectionStatus } from '../schema/enums.js';
import type { IntegrationConfig } from '../schema/integrations.js';
import { AgencyAccessDenied } from './authenticated-actor.js';
import { toDate, toDateOrNull } from './pg-time.js';

export type IntegrationQueryHandle = QueryHandle;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];
export type IntegrationConnectionStatus = (typeof connectionStatus.enumValues)[number];

export interface IntegrationConnectionRecord {
  id: string;
  orgId: string;
  provider: IntegrationProvider;
  label: string;
  config: IntegrationConfig;
  status: IntegrationConnectionStatus;
  hasSecret: boolean;
  connectedBy: string | null;
  connectedAt: Date | null;
  lastSyncedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateIntegrationConnectionInput {
  orgId: string;
  provider: IntegrationProvider;
  label: string;
  connectedBy?: string | null;
  config?: IntegrationConfig;
}

export interface SetIntegrationConnectionStatusInput {
  orgId: string;
  connectionId: string;
  status: IntegrationConnectionStatus;
  /** Safe operator-facing text only. Never pass a raw provider, HTTP, or Vault error. */
  lastError?: string | null;
}

interface IntegrationConnectionRow {
  id: string;
  org_id: string;
  provider: IntegrationProvider;
  label: string;
  config: IntegrationConfig;
  status: IntegrationConnectionStatus;
  has_secret: boolean;
  connected_by: string | null;
  connected_at: Date | string | null;
  last_synced_at: Date | string | null;
  last_error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const toRecord = (row: IntegrationConnectionRow): IntegrationConnectionRecord => ({
  id: row.id,
  orgId: row.org_id,
  provider: row.provider,
  label: row.label,
  config: row.config ?? {},
  status: row.status,
  hasSecret: row.has_secret,
  connectedBy: row.connected_by,
  connectedAt: toDateOrNull(row.connected_at),
  lastSyncedAt: toDateOrNull(row.last_synced_at),
  lastError: row.last_error,
  createdAt: toDate(row.created_at),
  updatedAt: toDate(row.updated_at),
});

function normalizeLabel(value: string): string {
  const label = value.trim();
  if (!label) throw new Error('An integration connection label cannot be empty');
  return label;
}

function serializeConfig(config: IntegrationConfig | undefined): string {
  const serialized = JSON.stringify(config ?? {});
  if (serialized === undefined) throw new Error('Integration config must be JSON-serializable');
  return serialized;
}

/** List one organisation's connections without exposing Vault ids or values. */
export async function listIntegrationConnections(
  handle: QueryHandle,
  orgId: string,
): Promise<IntegrationConnectionRecord[]> {
  const rows = await handle.sql<IntegrationConnectionRow[]>`
    select c.id, c.org_id, c.provider::text as provider, c.label, c.config,
           c.status::text as status,
           (c.vault_secret_id is not null) as has_secret,
           c.connected_by, c.connected_at, c.last_synced_at, c.last_error,
           c.created_at, c.updated_at
      from public.integration_connections c
     where c.org_id = ${orgId}
     order by c.provider, lower(c.label), c.created_at, c.id
  `;
  return rows.map(toRecord);
}

/**
 * Create pending metadata, or reuse the unique provider/label row for a retry
 * or rotation. Store the credential through `storeIntegrationSecret` next.
 */
export async function createIntegrationConnection(
  handle: IntegrationQueryHandle,
  input: CreateIntegrationConnectionInput,
): Promise<IntegrationConnectionRecord> {
  const rows = await handle.sql<IntegrationConnectionRow[]>`
    insert into public.integration_connections
      (org_id, provider, label, connected_by, config)
    values (
      ${input.orgId}, ${input.provider}::public.integration_provider, ${normalizeLabel(input.label)},
      ${input.connectedBy ?? null}, ${serializeConfig(input.config)}::text::jsonb
    )
    on conflict (org_id, provider, label) do update
      set connected_by = excluded.connected_by,
          status = 'pending',
          last_error = null
    returning id, org_id, provider::text as provider, label, config,
              status::text as status, (vault_secret_id is not null) as has_secret,
              connected_by, connected_at, last_synced_at, last_error, created_at, updated_at
  `;
  const row = rows[0];
  if (!row) throw new Error('Creating an integration connection returned no row');
  return toRecord(row);
}

/** Set provider health state/error, scoped to the owning organisation. */
export async function setIntegrationConnectionStatus(
  handle: IntegrationQueryHandle,
  input: SetIntegrationConnectionStatusInput,
): Promise<IntegrationConnectionRecord> {
  const rows = await handle.sql<IntegrationConnectionRow[]>`
    update public.integration_connections
       set status = ${input.status}::public.connection_status,
           last_error = ${input.lastError ?? null}
     where org_id = ${input.orgId} and id = ${input.connectionId}
    returning id, org_id, provider::text as provider, label, config,
              status::text as status, (vault_secret_id is not null) as has_secret,
              connected_by, connected_at, last_synced_at, last_error, created_at, updated_at
  `;
  const row = rows[0];
  if (!row) throw new Error('Integration connection not found');
  return toRecord(row);
}

/** A generic boundary error that cannot carry postgres.js's bound credential parameter. */
export class IntegrationSecretStoreError extends Error {
  constructor() {
    super('The integration credential could not be stored');
    this.name = 'IntegrationSecretStoreError';
  }
}

/** Store or rotate a credential. Returns the safe-to-log Vault row id, never the value. */
export async function storeIntegrationSecret(
  handle: IntegrationQueryHandle,
  connectionId: string,
  value: string,
): Promise<string> {
  let rows: { store_integration_secret: string }[];
  try {
    rows = await handle.sql<{ store_integration_secret: string }[]>`
      select public.store_integration_secret(${connectionId}, ${value})
    `;
  } catch {
    // postgres.js attaches bind parameters to query errors. Never let that
    // object cross this boundary, even as a non-enumerable property or cause.
    throw new IntegrationSecretStoreError();
  }
  const secretId = rows[0]?.store_integration_secret;
  if (!secretId) throw new Error('store_integration_secret returned no secret id');
  return secretId;
}

/** Read a credential back. Service-role worker only; null means none is stored. */
export async function getIntegrationSecret(
  handle: IntegrationQueryHandle,
  connectionId: string,
): Promise<string | null> {
  const rows = await handle.sql<{ get_integration_secret: string | null }[]>`
    select public.get_integration_secret(${connectionId})
  `;
  return rows[0]?.get_integration_secret ?? null;
}

/** Delete the Vault row and mark the connection revoked. True when a secret existed. */
export async function revokeIntegrationSecret(
  handle: IntegrationQueryHandle,
  connectionId: string,
): Promise<boolean> {
  const rows = await handle.sql<{ revoke_integration_secret: boolean }[]>`
    select public.revoke_integration_secret(${connectionId})
  `;
  return rows[0]?.revoke_integration_secret ?? false;
}

/** Parameter-free failure for a complete credential operation, including COMMIT. */
export class IntegrationCredentialCommandError extends Error {
  constructor(readonly code: 'invalid' | 'not_found' | 'unavailable' = 'unavailable') {
    super(code === 'invalid' ? 'Invalid integration settings'
      : code === 'not_found' ? 'Integration connection not found'
        : 'The credential change could not be confirmed. Refresh the connection list before trying again.');
    this.name = 'IntegrationCredentialCommandError';
  }
}

/** One current-manager operation; a clean storage refusal commits a safe error row. */
export async function connectIntegrationCredentialForActor(
  handle: Pick<DbHandle, 'sql'>,
  rawActor: OrgActor,
  details: Pick<CreateIntegrationConnectionInput, 'provider' | 'label'>,
  credential: string,
): Promise<void> {
  try {
    if (!INTEGRATION_PROVIDERS.includes(details.provider) || typeof details.label !== 'string'
      || !details.label.trim() || typeof credential !== 'string' || credential.length === 0) {
      throw new IntegrationCredentialCommandError('invalid');
    }
    // Explicit construction prevents a structurally wider request from supplying
    // org, creator, config or a Vault pointer to the persistence primitive.
    const provider = details.provider;
    const label = details.label.trim();
    await withCurrentIntegrationManager(handle, rawActor, async (sql, actor) => {
      const connection = await createIntegrationConnection({ sql }, {
        orgId: actor.orgId, connectedBy: actor.userId, provider, label,
      });
      // The service-only SQL function rolls back recoverable storage failures
      // inside PostgreSQL. Avoid the driver's client savepoint recovery path:
      // a backend disconnect there can escape its promise error boundary.
      const attempt = await sql<{ stored: boolean }[]>`
        select app.try_store_integration_secret(${connection.id}::uuid,${credential}) as stored`;
      if (attempt.length !== 1 || typeof attempt[0]?.stored !== 'boolean') throw new IntegrationCredentialCommandError();
      const stored = attempt[0].stored;
      if (!stored) {
        await setIntegrationConnectionStatus({ sql }, {
          orgId: actor.orgId, connectionId: connection.id, status: 'error',
          lastError: 'The credential could not be stored in Vault.',
        });
      }
      const confirmed = await sql`select id from public.integration_connections
        where org_id=${actor.orgId} and id=${connection.id}
          and status=${stored ? 'active' : 'error'}::public.connection_status
          and (vault_secret_id is not null)=${stored || connection.hasSecret}`;
      if (confirmed.length !== 1) throw new IntegrationCredentialCommandError();
      await auditIntegrationCredential(sql, actor, connection.id,
        stored ? 'integration.credential_connected' : 'integration.credential_store_failed',
        { provider, stored });
    });
  } catch (error) { throw safeCredentialCommandError(error); }
}

/** Scopes and locks the connection before the service-only, ID-based Vault RPC. */
export async function revokeIntegrationCredentialForActor(
  handle: Pick<DbHandle, 'sql'>,
  rawActor: OrgActor,
  connectionId: string,
): Promise<void> {
  try {
    const parsed = Uuid.safeParse(connectionId);
    if (!parsed.success) throw new IntegrationCredentialCommandError('invalid');
    await withCurrentIntegrationManager(handle, rawActor, async (sql, actor) => {
      const owned = await sql`select id from public.integration_connections
        where org_id=${actor.orgId} and id=${parsed.data} for update`;
      if (owned.length !== 1) throw new IntegrationCredentialCommandError('not_found');
      const secretRemoved = await revokeIntegrationSecret({ sql }, parsed.data);
      const confirmed = await sql`select id from public.integration_connections
        where org_id=${actor.orgId} and id=${parsed.data} and status='revoked' and vault_secret_id is null`;
      if (confirmed.length !== 1) throw new IntegrationCredentialCommandError();
      await auditIntegrationCredential(sql, actor, parsed.data, 'integration.credential_revoked', { secretRemoved });
    });
  } catch (error) { throw safeCredentialCommandError(error); }
}

/** Private to complete credential commands; never export a privileged callback. */
async function withCurrentIntegrationManager<T>(
  handle: Pick<DbHandle, 'sql'>,
  rawActor: OrgActor,
  operation: (sql: postgres.TransactionSql, actor: Readonly<OrgActor>) => Promise<T>,
): Promise<T> {
  const actor = Object.freeze(OrgActor.parse(rawActor));
  const result = await handle.sql.begin(async (sql) => {
    const [prior] = await sql<{
      role: string; claims: string | null; subject: string | null; claim_role: string | null; service: boolean;
    }[]>`select current_setting('role') as role,
      current_setting('request.jwt.claims', true) as claims,
      current_setting('request.jwt.claim.sub', true) as subject,
      current_setting('request.jwt.claim.role', true) as claim_role,
      app.is_service_role() as service`;
    if (!prior?.service) throw new IntegrationCredentialCommandError();
    await sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: actor.userId, role: 'authenticated' })}, true),
      set_config('request.jwt.claim.sub', ${actor.userId}, true), set_config('request.jwt.claim.role', 'authenticated', true)`;
    await sql`set local role authenticated`;
    await sql`select app.lock_org_editor(${actor.orgId}::uuid)`;
    // The command already holds FOR SHARE. Direct authenticated row-lock SQL
    // would require the intentionally revoked org_members UPDATE privilege.
    const [membership] = await sql<{ role: string }[]>`select role::text as role from public.org_members
      where org_id=${actor.orgId} and user_id=auth.uid()`;
    const role = OrgRole.safeParse(membership?.role);
    if (!role.success || !(ORG_CAPABILITY_ROLES.manageConnection as readonly string[]).includes(role.data)) {
      throw new AgencyAccessDenied();
    }
    // Restore the actual caller, never fabricate service claims or RESET ROLE
    // to a stronger session default. Missing custom GUCs normalize to empty.
    await sql`select set_config('role', ${prior.role}, true)`;
    await sql`select set_config('request.jwt.claims', ${prior.claims ?? ''}, true),
      set_config('request.jwt.claim.sub', ${prior.subject ?? ''}, true),
      set_config('request.jwt.claim.role', ${prior.claim_role ?? ''}, true)`;
    const [restored] = await sql<{ valid: boolean }[]>`select
      current_setting('role')=${prior.role}
      and coalesce(current_setting('request.jwt.claims', true),'')=${prior.claims ?? ''}
      and coalesce(current_setting('request.jwt.claim.sub', true),'')=${prior.subject ?? ''}
      and coalesce(current_setting('request.jwt.claim.role', true),'')=${prior.claim_role ?? ''}
      and app.is_service_role() as valid`;
    if (!restored?.valid) throw new IntegrationCredentialCommandError();
    // Subsequent SQL is privileged. Each complete command derives its scope
    // from this actor and holds the membership lock through its final audit.
    return { value: await operation(sql, actor) };
  });
  return result.value;
}

async function auditIntegrationCredential(
  sql: postgres.TransactionSql,
  actor: OrgActor,
  connectionId: string,
  action: 'integration.credential_connected' | 'integration.credential_store_failed' | 'integration.credential_revoked',
  payload: { provider: IntegrationProvider; stored: boolean } | { secretRemoved: boolean },
): Promise<void> {
  const rows = await sql`insert into public.audit_log
    (org_id,actor_type,actor_id,action,target_type,target_id,payload,source)
    values (${actor.orgId},'user',${actor.userId},${action},'integration_connection',${connectionId},
      ${JSON.stringify(payload)}::jsonb,'web') returning id`;
  if (rows.length !== 1) throw new IntegrationCredentialCommandError();
}

function safeCredentialCommandError(error: unknown): Error {
  if (error instanceof IntegrationCredentialCommandError || error instanceof AgencyAccessDenied) return error;
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === '42501') {
    return new AgencyAccessDenied();
  }
  // Never retain a driver object, message, properties, cause or submitted value.
  return new IntegrationCredentialCommandError();
}
