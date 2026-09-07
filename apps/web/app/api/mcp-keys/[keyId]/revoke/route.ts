/**
 * Revoke an MCP API key.
 *
 * Revocation is immediate — the MCP server rejects a revoked key on its next
 * request — and idempotent, so a double-click keeps the first timestamp. Scoped
 * to the actor's org, so a key id pasted from another tenant returns 404 rather
 * than touching a key that is not theirs.
 */
import { revokeMcpKey } from '../../../../../src/data/mcp-keys';
import { openWebDatabase, requestActor } from '../../../../../src/server/request-context';
import { requireCapability } from '../../../../../src/server/org-role';
import { mcpKeyError, mcpKeyResponse, requireMcpKeyOrigin } from '../../../../../src/server/mcp-key-response';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ keyId: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  let database: ReturnType<typeof openWebDatabase> | undefined;
  try {
    requireMcpKeyOrigin(request);
    database = openWebDatabase();
    const actor = await requestActor(request.headers);
    await requireCapability(database, actor, 'manageConnection');
    const { keyId } = await context.params;

    const revoked = await revokeMcpKey(database, actor, keyId);
    if (!revoked) return mcpKeyResponse(Response.json({ error: 'Key not found' }, { status: 404 }));
    return mcpKeyResponse(Response.json({ revoked: true }));
  } catch (error) {
    return mcpKeyError(error);
  } finally {
    await database?.close();
  }
}
