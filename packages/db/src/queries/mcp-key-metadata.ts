import { McpKeyMetadata } from '@wizard-ads/shared';
import type { QueryHandle } from '../client.js';

interface MetadataRow {
  id: string; label: string; key_prefix: string; scope: string;
  profile_ids: string[] | null;
  expires_at: Date | string | null; revoked_at: Date | string | null;
  last_used_at: Date | string | null; created_at: Date | string;
}

/** Execute inside withAuthenticatedActor; the SQL function rechecks membership. */
export async function listMcpKeyMetadata(handle: QueryHandle, orgId: string): Promise<McpKeyMetadata[]> {
  const rows = await handle.sql<MetadataRow[]>`select * from public.list_mcp_key_metadata(${orgId}::uuid)`;
  return rows.map((row) => McpKeyMetadata.parse({
    id: row.id, label: row.label, keyPrefix: row.key_prefix, scope: row.scope,
    profileIds: row.profile_ids, createdAt: new Date(row.created_at).toISOString(),
    expiresAt: iso(row.expires_at), revokedAt: iso(row.revoked_at), lastUsedAt: iso(row.last_used_at),
  }));
}

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}
