import { z } from 'zod';
import { Uuid } from './primitives.js';

/** Display metadata only. A key's token and digest never cross this boundary. */
export const McpKeyMetadata = z.object({
  id: Uuid,
  label: z.string(),
  keyPrefix: z.string(),
  scope: z.enum(['read', 'write']),
  /** Null remains valid for historical keys without a profile allowlist. */
  profileIds: z.array(Uuid).nullable(),
  expiresAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  lastUsedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
}).strict();
export type McpKeyMetadata = z.infer<typeof McpKeyMetadata>;

export const MCP_KEY_EXPIRY_DAY_OPTIONS = [7, 30, 90] as const;
export const DEFAULT_MCP_KEY_EXPIRY_DAYS = 30;
export const McpKeyExpiryDays = z.union([z.literal(7), z.literal(30), z.literal(90)]);

/** A manager's read-key command contains only a digest, never the raw token. */
export const McpReadKeyIssue = z.object({
  label: z.string().trim().min(1).max(200),
  profileIds: z.array(Uuid).min(1).max(10_000),
  expiresInDays: McpKeyExpiryDays,
  keyPrefix: z.string().regex(/^wza_[A-Za-z0-9_-]{8}$/),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type McpReadKeyIssue = z.infer<typeof McpReadKeyIssue>;
