import { AgencyAccessDenied, withAuthenticatedActor } from '@wizard-ads/db';
import type { DbHandle, QueryHandle, QuerySql } from '@wizard-ads/db';
import type { OrgActor } from '@wizard-ads/shared';
import type { McpConfig } from './config.js';
import type { KeyScopeContext } from './data.js';
import { ToolError } from './errors.js';
import type { ServedKeyScope } from './keys.js';

/** Identity comes only from the HTTP token verifier, never tool arguments. */
export interface ServerContext {
  handle: DbHandle;
  config: McpConfig;
  actor: OrgActor;
  keyId: string;
  /** The verified key's class. It decides which tools exist; the database rechecks it on every call. */
  scope?: ServedKeyScope;
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

/** A `creator:write` operation: the open authenticated transaction, bound to one org and one key. */
export interface CreatorWriteOperationContext {
  sql: QuerySql;
  actor: OrgActor;
  keyId: string;
  orgSlug: string;
}

/**
 * Run one `creator:write` tool in one authenticated transaction. The key is
 * rechecked in the database before and after the work: its class, its issuer's
 * current owner or admin membership, expiry and revocation. A read key fails
 * here, just as a creator:write key fails `app.authorize_mcp_read_key`, so the
 * two classes cannot reach each other's tools even if one were registered.
 */
export async function withCreatorWriteOperation<T>(
  context: ServerContext,
  operation: (context: CreatorWriteOperationContext) => Promise<T>,
): Promise<T> {
  try {
    return await withAuthenticatedActor(context.handle, context.actor, async (sql) => {
      const authorize = async () => {
        const [scope] = await sql<{ org_slug: string }[]>`
          select * from app.authorize_mcp_creator_write_key(${context.keyId}::uuid, ${context.actor.orgId}::uuid)
        `;
        if (!scope) throw denied();
        return scope;
      };
      const scope = await authorize();
      const result = await operation({ sql, actor: context.actor, keyId: context.keyId, orgSlug: scope.org_slug });
      await authorize();
      return result;
    });
  } catch (error) {
    if (error instanceof AgencyAccessDenied) throw denied();
    throw error;
  }
}
