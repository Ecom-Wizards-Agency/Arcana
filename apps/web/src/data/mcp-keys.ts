/**
 * MCP API keys, read and written from the web app.
 *
 * WP-09 shipped the model — the `mcp.api_keys` table (migration
 * `20260814120000_mcp_api_keys.sql`), the `apps/mcp` server that verifies a
 * bearer token against it, and a `keys` CLI that issues one. What it did not
 * ship is the surface an operator uses without a terminal. This file is that
 * surface's data layer: it issues, lists and revokes keys against the same
 * table, using the same token shape the server verifies.
 *
 * The token shape is copied deliberately, not imported: `apps/mcp/src/keys.ts`
 * is the spec (an app is not a library and `apps/web` must not depend on a
 * sibling app), so the constants below — the `wza_` prefix, the 32 random bytes,
 * the SHA-256 hex hash, the 12-character stored prefix — must stay identical to
 * it or a key issued here will not verify there. v1 issues **read-only** keys,
 * exactly as the CLI does.
 *
 * The plaintext token exists only in `issueMcpKey`'s return value and is never
 * stored — only its hash and a short prefix are — so a lost token is reissued,
 * never recovered.
 */
import { createHash, randomBytes } from 'node:crypto';
import { issueManagedMcpReadKey, revokeManagedMcpKey, type DbHandle } from '@wizard-ads/db';
import type { McpKeyMetadata, OrgActor } from '@wizard-ads/shared';
export { listMcpKeyMetadata as listMcpKeys } from '@wizard-ads/db';
import {
  DEFAULT_MCP_KEY_EXPIRY_DAYS,
  isMcpKeyExpiryDays,
  MCP_KEY_EXPIRY_DAY_OPTIONS,
} from '../mcp-key-policy';

/** Structural handle: both the pooled `DbHandle` and the per-request one fit. */
export type SqlHandle = Pick<DbHandle, 'sql'>;

const TOKEN_PREFIX = 'wza_';
const STORED_PREFIX_LENGTH = 12;

function generateToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export type McpKeyRecord = McpKeyMetadata;

export interface IssuedMcpKey {
  record: McpKeyRecord;
  /** The plaintext token — shown once, never persisted, never retrievable. */
  token: string;
}

export interface IssueMcpKeyInput {
  orgId: string;
  label: string;
  /** A required hard allowlist. Every id is verified against `orgId`. */
  profileIds: readonly string[];
  /** Accepted only when it is one of `MCP_KEY_EXPIRY_DAY_OPTIONS`. */
  expiresInDays?: number;
  /** The auth user issuing it, recorded for the audit trail. */
  createdBy: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Issue one expiring, read-only key for an explicit profile allowlist.
 * Profile ownership is checked before the credential row is written. The MCP
 * server independently enforces this same allowlist on every tool call.
 */
export async function issueMcpKey(handle: SqlHandle, input: IssueMcpKeyInput): Promise<IssuedMcpKey> {
  const label = input.label.trim();
  if (label.length === 0) throw new Error('A key needs a label so you can tell your keys apart.');

  const profileIds = [...new Set(input.profileIds)];
  if (profileIds.length === 0) throw new Error('Select at least one profile for this key.');
  if (!profileIds.every((profileId) => UUID.test(profileId))) {
    throw new Error('Every selected profile must be a valid profile id.');
  }

  const expiresInDays = input.expiresInDays ?? DEFAULT_MCP_KEY_EXPIRY_DAYS;
  if (!isMcpKeyExpiryDays(expiresInDays)) {
    throw new Error(`Key expiry must be ${MCP_KEY_EXPIRY_DAY_OPTIONS.join(', ')} days.`);
  }
  const token = generateToken();
  const record = await issueManagedMcpReadKey(handle, { orgId: input.orgId, userId: input.createdBy }, {
    label, profileIds, expiresInDays,
    keyPrefix: token.slice(0, STORED_PREFIX_LENGTH), tokenHash: hashToken(token),
  });
  return { record, token };
}

/**
 * Revoke a key. Idempotent (a second revoke keeps the first timestamp) and
 * tenant-scoped, so one org can never revoke another's key by pasting an id.
 * Returns false when no key with that id belongs to the org.
 */
export async function revokeMcpKey(handle: SqlHandle, actor: OrgActor, keyId: string): Promise<boolean> {
  return revokeManagedMcpKey(handle, actor, keyId);
}
