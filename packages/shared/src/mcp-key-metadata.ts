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
