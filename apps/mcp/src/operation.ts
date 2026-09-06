import { AgencyAccessDenied, withAuthenticatedActor } from '@wizard-ads/db';
import type { DbHandle, QueryHandle } from '@wizard-ads/db';
import type { OrgActor } from '@wizard-ads/shared';
import type { McpConfig } from './config.js';
import type { KeyScopeContext } from './data.js';
import { ToolError } from './errors.js';

/** Identity comes only from the HTTP token verifier, never tool arguments. */
export interface ServerContext {
  handle: DbHandle;
  config: McpConfig;
  actor: OrgActor;
  keyId: string;
}

/** Tool implementations receive only the open authenticated transaction. */
export interface OperationContext {
  handle: QueryHandle;
  config: McpConfig;
  actor: OrgActor;
  keyId: string;
  scope: KeyScopeContext;
  orgSlug: string;
}

const denied = () => new ToolError('forbidden', 'This key no longer has access. Check your agency membership and API key settings.');

export async function withMcpOperation<T>(
  context: ServerContext,
  operation: (context: OperationContext) => Promise<T>,
): Promise<T> {
  try {
    return await withAuthenticatedActor(context.handle, context.actor, async (sql) => {
      const authorize = async () => {
        const [scope] = await sql<{ org_slug: string; profile_ids: string[] }[]>`
          select * from app.authorize_mcp_read_key(${context.keyId}::uuid, ${context.actor.orgId}::uuid)
        `;
        if (!scope) throw denied();
        return scope;
      };
      const scope = await authorize();
      const result = await operation({
        handle: { sql }, config: context.config, actor: context.actor, keyId: context.keyId,
        scope: { orgId: context.actor.orgId, profileIds: scope.profile_ids }, orgSlug: scope.org_slug,
      });
      // A request can span several reads. Do not return an accumulated response
      // after revocation, membership removal, expiry or an allowlist change.
      const current = await authorize();
      if (JSON.stringify([...current.profile_ids].sort()) !== JSON.stringify([...scope.profile_ids].sort())) {
        throw denied();
      }
      return result;
    });
  } catch (error) {
    if (error instanceof AgencyAccessDenied) throw denied();
    throw error;
  }
}
