import type { ScreenActor } from '../../server/page-read';

import type { ScreenParams } from '../types';

/**
 * `/connect-claude` — the AI (MCP) surface.
 *
 * The recon found the incumbent shipping an `AI → MCP` nav item and generating
 * the key itself in settings (`https://github.com/Ecom-Wizards-Agency/Arcana/blob/dd4f3887f626128250abee537f374712ca42717c/tools/recon/01-navigation-map.md`). WP-09 built
 * our half of that — the `apps/mcp` server and the `mcp.api_keys` model — and
 * left the operator with only a CLI to issue a key. This page is the missing
 * entry: issue a read-only key, see the keys an org already has, and revoke one.
 *
 * Issuing and revoking are gated behind `manageConnection` (owner/admin), the
 * same role that connects Amazon, because a key that reads selected advertising
 * profiles is as sensitive as that grant. Everyone in the org can *see*
 * the roster, so a viewer knows a key exists and who holds what.
 *
 * Entry goes through `gate()`; the key list is scoped by the org it resolves.
 */

import { can } from '../../auth/roles';

import { mcpEndpoint } from '../../env';

import { listMcpKeys } from '../../data/mcp-keys';

import { listProfiles } from '../../../app/_lib/profiles';

export async function load(access: ScreenActor, _input: ScreenParams) {

  const entry = access.entry;
  if (entry.state !== 'ok') {
    return { view: 'gated' as const, props: { entry } };
  }
  const { context } = entry;
  const org = context.active;
  if (!org) return null;

  const [keys, profiles] = await access.readSql((sql) => Promise.all([
    listMcpKeys({ sql }, org.orgId),
    listProfiles({ sql }, org.orgId),
  ]),
  );
  const canManage = can(org.role, 'manageConnection');
  const endpoint = mcpEndpoint();

  return { view: 'ready' as const, props: { endpoint, keys, profiles, canManage, org } };
}
