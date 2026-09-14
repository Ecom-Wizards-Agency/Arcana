import {
  ConnectionProvider, ProviderConnectionHealth, Uuid,
  type AmazonConnectionBegin, type AmazonConnectionSubmit, type AmazonConnectionOperation,
  type AmazonConnectionClaim, type ProviderConnectionLifecycle, type OrgActor,
} from '@wizard-ads/shared';
import { withAuthenticatedActor } from './authenticated-actor.js';
import { beginAmazonConnection, submitAmazonConnection, cancelAmazonConnection, readAmazonConnection } from './amazon-connection-operations.js';
import { claimAmazonConnection, readAmazonConnectionWorker, attachAmazonConnectionGrant } from './amazon-connection-worker.js';
/**
 * Connection lookups the worker needs to build an Amazon client.
 *
 * The refresh token itself never lives here — it moves only through the Vault
 * `security definer` functions in `tokens.ts`. These two reads answer the
 * questions those functions cannot: which connection a profile belongs to, and
 * which connections can be probed in a region. Both are plain, non-secret
 * columns.
 */
import { AdsConnectionCredentialBinding, type Region } from '@wizard-ads/shared';
import type { DbHandle } from '../client.js';

/**
 * The connection a profile is grafted onto, or null when it has none (a profile
 * whose connection was deleted keeps its row with `connection_id` null).
 */
export async function getProfileConnectionId(
  handle: DbHandle,
  profileId: string,
): Promise<string | null> {
  const rows = await handle.sql<{ connection_id: string | null }[]>`
    select p.connection_id from public.ad_profiles p
      join public.ads_connections c on c.id = p.connection_id and c.org_id = p.org_id
     where p.id = ${profileId}
  `;
  return rows[0]?.connection_id ?? null;
}

/**
 * Active connections with a stored credential that have at least one profile in
 * `region`. The auth healthcheck probes exactly these: a connection with no
 * profile in a region gives no host to ask, and a connection with no vault
 * secret has nothing to authenticate with.
 */
export async function listActiveConnectionIdsForRegion(
  handle: DbHandle,
  region: Region,
): Promise<string[]> {
  const rows = await handle.sql<{ id: string }[]>`
    select distinct c.id
      from public.ads_connections c
      join public.ad_profiles p on p.connection_id = c.id and p.org_id = c.org_id
     where c.status = 'active'
       and c.vault_secret_id is not null
       and p.region = ${region}
  `;
  return rows.map((row) => row.id);
}

/** Match the worker's complete routing context before selecting any credential. */
export async function getProfileCredentialBinding(
  handle: Pick<DbHandle, 'sql'>,
  orgId: string,
  profileId: string,
  amazonProfileId: string,
  region: Region,
): Promise<AdsConnectionCredentialBinding | null> {
  const rows = await handle.sql<{ binding: unknown }[]>`
    select jsonb_build_object('orgId', c.org_id, 'connectionId', c.id,
      'generation', c.credential_generation::text) as binding
      from public.ad_profiles p
      join public.ads_connections c on c.org_id = p.org_id and c.id = p.connection_id
     where p.org_id = ${orgId} and p.id = ${profileId}
       and p.amazon_profile_id = ${amazonProfileId} and p.region = ${region}
       and c.status = 'active' and c.vault_secret_id is not null
  `;
  if (rows.length > 1) throw new Error('Profile credential binding count mismatch');
  return rows[0] ? AdsConnectionCredentialBinding.parse(rows[0].binding) : null;
}

/** Worker health probes also check the fresh generation before cache reuse. */
export async function getConnectionCredentialBinding(
  handle: Pick<DbHandle, 'sql'>,
  connectionId: string,
): Promise<AdsConnectionCredentialBinding | null> {
  const rows = await handle.sql<{ binding: unknown }[]>`
    select jsonb_build_object('orgId', org_id, 'connectionId', id,
      'generation', credential_generation::text) as binding
      from public.ads_connections
     where id = ${connectionId} and status = 'active' and vault_secret_id is not null
  `;
  if (rows.length > 1) throw new Error('Connection credential binding count mismatch');
  return rows[0] ? AdsConnectionCredentialBinding.parse(rows[0].binding) : null;
}

/** Provider-neutral application seam; worker custody remains service-role protected. */
export function createAdsConnectionLifecycle(
  handle: Pick<DbHandle, 'sql'>,
  enabled: () => boolean = () => false,
): ProviderConnectionLifecycle<AmazonConnectionBegin, AmazonConnectionSubmit, AmazonConnectionOperation, AmazonConnectionClaim> {
  const gate = (): void => { if (!enabled()) throw new Error('Provider connections are disabled'); };
  return {
    provider: 'amazon_ads',
    begin: (actor, input) => { gate(); return beginAmazonConnection(handle, actor, input); },
    submit: (actor, input) => { gate(); return submitAmazonConnection(handle, actor, input); },
    cancel: (actor, id) => cancelAmazonConnection(handle, actor, id),
    operation: (actor, id) => readAmazonConnection(handle, actor, id),
    health: (actor, id) => providerConnectionHealth(handle, actor, 'amazon_ads', id, false),
    revoke: (actor, id) => providerConnectionHealth(handle, actor, 'amazon_ads', id, true),
    custody: {
      claim: (lease) => claimAmazonConnection(handle, lease),
      read: (id) => readAmazonConnectionWorker(handle, id),
      attach: (id, lease, refresh) => attachAmazonConnectionGrant(handle, id, lease, refresh),
    },
  };
}

/** Fixed metadata only, under current-user RLS and the command's manager lock. */
export async function providerConnectionHealth(
  handle: Pick<DbHandle, 'sql'>, actor: OrgActor, provider: ConnectionProvider,
  connectionId: string, revoke = false,
): Promise<ProviderConnectionHealth | null> {
  const id = Uuid.parse(connectionId);
  const parsedProvider = ConnectionProvider.parse(provider);
  const result = await withAuthenticatedActor(handle, actor, async (sql) => {
    const rows = await sql<{ result: unknown }[]>`
      select app.provider_connection_health(${actor.orgId},${parsedProvider},${id},${revoke}) as result
    `;
    if (rows.length !== 1) throw new Error('Provider connection health count mismatch');
    return rows[0]!.result === null ? null : ProviderConnectionHealth.parse(rows[0]!.result);
  });
  if (revoke && result !== null && parsedProvider === 'amazon_spapi') {
    // The operator command has already closed credential reads. Cleanup can only
    // touch that exact revoked connection; it cannot revoke a replacement grant.
    const rows = await handle.sql<{ cleaned: boolean }[]>`
      select app.clean_revoked_spapi_credential(${actor.orgId},${id}) as cleaned
    `;
    if (rows.length !== 1 || rows[0]?.cleaned !== true) throw new Error('Provider revocation cleanup could not be verified');
  }
  return result;
}
