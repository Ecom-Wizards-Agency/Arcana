/**
 * Issue an MCP API key.
 *
 * The same gate as connecting Amazon (`manageConnection` — owner/admin only): a
 * key that can read selected advertising profiles is exactly as sensitive as
 * the Amazon grant, and should sit behind the same role. The plaintext token is
 * in the response once and never again, which the UI states plainly next to it.
 */
import { mutationBody, mutationUuid, MutationInputError } from '../../../src/server/authenticated-mutation';
import { issueMcpKey } from '../../../src/data/mcp-keys';
import {
  DEFAULT_MCP_KEY_EXPIRY_DAYS,
  isMcpKeyExpiryDays,
} from '../../../src/mcp-key-policy';
import { openWebDatabase, requestActor } from '../../../src/server/request-context';
import { mcpKeyError, mcpKeyResponse, requireMcpKeyOrigin } from '../../../src/server/mcp-key-response';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  try {
    requireMcpKeyOrigin(request);
    const actor = await requestActor(request.headers);
    // Exception: the managed-key command owns the single authenticated transaction.
    // Its SQL command takes app.lock_org_manager before checking owner/admin
    // authority and mutating. Wrapping it would open a second transaction.
    const database = openWebDatabase();
    try {
      const body = (await mutationBody(request)) as {
        label?: unknown;
        profileIds?: unknown;
        expiresInDays?: unknown;
      };
      if (typeof body.label !== 'string' || body.label.trim().length === 0) {
        throw new MutationInputError('A key needs a label so you can tell your keys apart.');
      }
      if (
        !Array.isArray(body.profileIds) ||
        body.profileIds.length === 0 ||
        !body.profileIds.every((profileId) => typeof profileId === 'string')
      ) {
        throw new MutationInputError('Select at least one profile for this key.');
      }
      for (const id of body.profileIds) mutationUuid(id, 'profileId');
      const expiresInDays = body.expiresInDays ?? DEFAULT_MCP_KEY_EXPIRY_DAYS;
      if (!isMcpKeyExpiryDays(expiresInDays)) {
        throw new MutationInputError('Choose one of the available expiry periods.');
      }

      const issued = await issueMcpKey(database, {
        orgId: actor.orgId,
        label: body.label,
        profileIds: body.profileIds,
        expiresInDays,
        createdBy: actor.userId,
      });
      return mcpKeyResponse(Response.json({ key: issued.record, token: issued.token }, { status: 201 }));
    } finally { await database.close(); }
  } catch (error) {
    return mcpKeyError(error);
  }
}
