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
import { mcpKeyError, mcpKeyResponse, requireMcpKeyOrigin } from '../../../../../src/server/mcp-key-response';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ keyId: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    requireMcpKeyOrigin(request);
    const actor = await requestActor(request.headers);
    // Exception: the managed-key command owns the single authenticated transaction.
    // Its SQL command takes app.lock_org_manager before checking owner/admin
    // authority and mutating. Wrapping it would open a second transaction.
    const database = openWebDatabase();
    try {
      const { keyId } = await context.params;

      const revoked = await revokeMcpKey(database, actor, keyId);
      if (!revoked) return mcpKeyResponse(Response.json({ error: 'Key not found' }, { status: 404 }));
      return mcpKeyResponse(Response.json({ revoked: true }));
    } finally { await database.close(); }
  } catch (error) {
    return mcpKeyError(error);
  }
}
