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
