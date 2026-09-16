/**
 * The Amazon connection, as the settings page needs it.
 *
 * `vault_secret_id` is selected only as a boolean. The web tier has no reason
 * to know the id and every reason not to print it, so the query answers "is
 * there a credential" and stops there.
 */
import type { QueryHandle } from '@wizard-ads/db';
import type { Region } from '@wizard-ads/shared';
import { operatorFailureLabel } from '../security/operator-failure';

export type ConnectionStatus = 'pending' | 'active' | 'error' | 'revoked';

export interface ConnectionSummary {
  id: string;
  label: string;
  status: ConnectionStatus;
  scope: string | null;
  hasCredential: boolean;
  connectedAt: string | null;
  lastHealthCheckAt: string | null;
  lastError: string | null;
  profileCount: number;
}

export async function listConnections(
  handle: QueryHandle,
  orgId: string,
): Promise<ConnectionSummary[]> {
  const rows = await handle.sql<
    {
      id: string;
      label: string;
      status: ConnectionStatus;
      scope: string | null;
      has_credential: boolean;
      connected_at: string | null;
      last_health_check_at: string | null;
      last_error: string | null;
      profile_count: string;
    }[]
  >`
    select c.id,
           c.label,
           c.status::text as status,
           c.scope,
           (c.vault_secret_id is not null) as has_credential,
           c.connected_at::text as connected_at,
           c.last_health_check_at::text as last_health_check_at,
           c.last_error,
           count(p.id) as profile_count
      from public.ads_connections c
      left join public.ad_profiles p on p.connection_id = c.id and p.org_id = c.org_id
     where c.org_id = ${orgId}
     group by c.id
     order by c.created_at
  `;
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    status: row.status,
    scope: row.scope,
    hasCredential: row.has_credential,
    connectedAt: row.connected_at,
    lastHealthCheckAt: row.last_health_check_at,
    lastError: operatorFailureLabel(row.last_error),
    profileCount: Number(row.profile_count),
  }));
}

export interface SpApiConnectionSummary {
  id: string; label: string; status: ConnectionStatus; hasCredential: boolean;
  bindingCount: number; enabledBindings: number;
}
export interface SpApiSelectableProfile {
  id: string; name: string; marketplaceId: string; countryCode: string;
  connectionLabel: string | null;
}

/** Metadata only, scoped by the page's authenticated transaction and exact org. */
export async function loadSpApiConnections(handle: QueryHandle, orgId: string, consentRegion: Region | null = null) {
  const connections = await handle.sql<Array<{ id: string; label: string; status: ConnectionStatus;
    has_credential: boolean; binding_count: number; enabled_bindings: number }>>`
    select c.id,c.label,c.status::text,(c.status = 'active' and c.vault_secret_id is not null) as has_credential,
      count(b.id)::int as binding_count,count(b.id) filter (where b.enabled)::int as enabled_bindings
    from public.spapi_connections c left join public.spapi_profile_bindings b on b.connection_id=c.id and b.org_id=c.org_id
    where c.org_id=${orgId} group by c.id order by c.created_at,c.id
  `;
  const profiles = await handle.sql<Array<{ id: string; name: string; country_code: string;
    marketplace_id: string; connection_label: string | null }>>`
    select p.id,coalesce(p.account_name,p.amazon_profile_id) as name,p.country_code,
      app.spapi_marketplace_for_country(p.country_code) as marketplace_id,c.label as connection_label
    from public.ad_profiles p left join public.spapi_profile_bindings b on b.profile_id=p.id and b.org_id=p.org_id
    left join public.spapi_connections c on c.id=b.connection_id and c.org_id=p.org_id
    where p.org_id=${orgId} and p.region::text=${consentRegion}
      and p.account_type='seller' and nullif(btrim(p.amazon_account_id),'') is not null
      and app.spapi_region_for_marketplace(app.spapi_marketplace_for_country(p.country_code))=p.region
    order by p.id
  `;
  return {
    connections: connections.map((row): SpApiConnectionSummary => ({ id: row.id,label: row.label,status: row.status,
      hasCredential: row.has_credential,bindingCount: row.binding_count,enabledBindings: row.enabled_bindings })),
    profiles: profiles.map((row): SpApiSelectableProfile => ({ id: row.id,name: row.name,countryCode: row.country_code,
      marketplaceId: row.marketplace_id,connectionLabel: row.connection_label })),
  };
}
