import { McpReadKeyIssue, Uuid, type McpKeyMetadata, type OrgActor } from '@wizard-ads/shared';
import type { DbHandle } from '../client.js';
import { AgencyAccessDenied, withAuthenticatedActor } from './authenticated-actor.js';
import { listMcpKeyMetadata } from './mcp-key-metadata.js';

/** Never retain a database error/cause: it may include bound key digests. */
export class McpKeyCommandError extends Error {
  constructor(readonly code: 'invalid' | 'unavailable') {
    super(code === 'invalid'
      ? 'The key settings are invalid or include an unavailable profile.'
      : 'The key operation could not be confirmed. Refresh the key list before trying again.');
    this.name = 'McpKeyCommandError';
  }
}

export async function issueManagedMcpReadKey(
  handle: Pick<DbHandle, 'sql'>, actor: OrgActor, rawCommand: McpReadKeyIssue,
): Promise<McpKeyMetadata> {
  const parsed = McpReadKeyIssue.safeParse(rawCommand);
  if (!parsed.success) throw new McpKeyCommandError('invalid');
  const command = parsed.data;
  try {
    return await withAuthenticatedActor(handle, actor, async (sql) => {
      const rows = await sql<{ id: string }[]>`select app.issue_mcp_read_key(
        ${actor.orgId}::uuid, ${command.label}, ${sql.array(command.profileIds)}::uuid[],
        ${command.expiresInDays}::integer, ${command.keyPrefix}, ${command.tokenHash}
      ) as id`;
      if (rows.length !== 1) throw new McpKeyCommandError('unavailable');
      const id = Uuid.parse(rows[0]!.id);
      const records = (await listMcpKeyMetadata({ sql }, actor.orgId)).filter((record) => record.id === id);
      if (records.length !== 1) throw new McpKeyCommandError('unavailable');
      return records[0]!;
    });
  } catch (error) { throw safeCommandError(error); }
}

export async function revokeManagedMcpKey(
  handle: Pick<DbHandle, 'sql'>, actor: OrgActor, rawKeyId: string,
): Promise<boolean> {
  const parsed = Uuid.safeParse(rawKeyId);
  if (!parsed.success) throw new McpKeyCommandError('invalid');
  try {
    return await withAuthenticatedActor(handle, actor, async (sql) => {
      const rows = await sql<{ revoked: boolean }[]>`select app.revoke_mcp_key(${actor.orgId}::uuid, ${parsed.data}::uuid) as revoked`;
      if (rows.length !== 1 || typeof rows[0]?.revoked !== 'boolean') throw new McpKeyCommandError('unavailable');
      return rows[0].revoked;
    });
  } catch (error) { throw safeCommandError(error); }
}

function safeCommandError(error: unknown): Error {
  if (error instanceof AgencyAccessDenied || error instanceof McpKeyCommandError) return error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  if (code === '42501') return new AgencyAccessDenied();
  return new McpKeyCommandError(code === '22023' ? 'invalid' : 'unavailable');
}
