/**
 * The host gate of the MCF unit (WP-338e; DESIGN section 8 and clause 2).
 *
 * Only `wizard-ads-mcf.service` runs this code. Two flags and one scope decide
 * which Amazon calls it may make:
 *
 *  - `OPENSPELL_MCF_PREVIEW_ENABLED` gates the address-bearing preview work:
 *    opening a sealed address, the getOrder check before a preview and
 *    getFulfillmentPreview.
 *  - `OPENSPELL_MCF_DISPATCH_ENABLED` gates dispatch: the re-read, the
 *    reservation and createFulfillmentOrder (and, later, cancels).
 *  - `OPENSPELL_MCF_SCOPE` lists the `<spapiConnectionUuid>:<marketplaceId>`
 *    pairs the unit may touch at all. Settlement reads of orders that may exist
 *    run for every scoped pair whenever the unit runs, flags on or off.
 *
 * A flag is on only when it is exactly "1"; empty, "0" or unset is off, and
 * any other value refuses to start. Errors name the variable, never its value.
 * The database gate (an active grant) is checked separately by every SQL call.
 */

export const MCF_PREVIEW_ENABLED_ENV = 'OPENSPELL_MCF_PREVIEW_ENABLED';
export const MCF_DISPATCH_ENABLED_ENV = 'OPENSPELL_MCF_DISPATCH_ENABLED';
export const MCF_SCOPE_ENV = 'OPENSPELL_MCF_SCOPE';

/** The same pattern the ledger's scope check uses: a lower-case connection uuid, a colon and a marketplace id. */
const SCOPE_ENTRY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[A-Z0-9]{9,16}$/;
/** The ledger accepts at most 50 scope entries. */
const MAX_SCOPE_ENTRIES = 50;

export interface McfSendPolicy {
  readonly previewEnabled: boolean;
  readonly dispatchEnabled: boolean;
  /** Distinct `<spapiConnectionUuid>:<marketplaceId>` pairs. */
  readonly scope: readonly string[];
}

/** Everything off and nothing in scope: what a failed policy read means. */
export const MCF_SEND_POLICY_OFF: McfSendPolicy = Object.freeze({ previewEnabled: false, dispatchEnabled: false, scope: Object.freeze([]) });

/** A fixed-code error: the message names the variable and the rule, never the value. */
export class McfPolicyError extends Error {
  constructor(readonly variable: string, readonly rule: 'invalid_flag' | 'invalid_scope' | 'duplicate_scope' | 'scope_required') {
    super(`${variable}: ${rule}`);
    this.name = 'McfPolicyError';
  }
}

function flag(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name];
  if (value === undefined || value === '' || value === '0') return false;
  if (value !== '1') throw new McfPolicyError(name, 'invalid_flag');
  return true;
}

function scope(env: NodeJS.ProcessEnv): string[] {
  const raw = env[MCF_SCOPE_ENV];
  if (raw === undefined || raw.trim() === '') return [];
  const entries = raw.split(',').map((entry) => entry.trim());
  if (entries.length > MAX_SCOPE_ENTRIES || entries.some((entry) => !SCOPE_ENTRY.test(entry))) {
    throw new McfPolicyError(MCF_SCOPE_ENV, 'invalid_scope');
  }
  if (new Set(entries).size !== entries.length) throw new McfPolicyError(MCF_SCOPE_ENV, 'duplicate_scope');
  return entries;
}

/**
 * Reads the unit's policy, failing closed. Missing flags authorize nothing;
 * credentials never imply permission. A flag that is on without a scope refuses.
 */
export function mcfSendPolicyFromEnv(env: NodeJS.ProcessEnv): McfSendPolicy {
  const previewEnabled = flag(env, MCF_PREVIEW_ENABLED_ENV);
  const dispatchEnabled = flag(env, MCF_DISPATCH_ENABLED_ENV);
  const pairs = scope(env);
  if ((previewEnabled || dispatchEnabled) && pairs.length === 0) throw new McfPolicyError(MCF_SCOPE_ENV, 'scope_required');
  return Object.freeze({ previewEnabled, dispatchEnabled, scope: Object.freeze(pairs) });
}

/** The scope pair of one send. */
export function mcfScopePair(spapiConnectionId: string, marketplaceId: string): string {
  return `${spapiConnectionId}:${marketplaceId}`;
}

export function mcfScopeCovers(policy: McfSendPolicy, spapiConnectionId: string, marketplaceId: string): boolean {
  return policy.scope.includes(mcfScopePair(spapiConnectionId, marketplaceId));
}

export type McfOutboxAction = 'preview' | 'dispatch' | 'settle';

/** The outbox actions this policy lets the unit claim. Settle reads need only a scope. */
export function mcfClaimableActions(policy: McfSendPolicy): McfOutboxAction[] {
  if (policy.scope.length === 0) return [];
  return [...(policy.previewEnabled ? ['preview' as const] : []), ...(policy.dispatchEnabled ? ['dispatch' as const] : []), 'settle'];
}

/**
 * Whether the next step of an action may run for this send. Preview and
 * dispatch steps need their flag; settle reads, and the reads that record the
 * outcome of a POST already sent, need only the scope.
 */
export function mcfStepAllowed(policy: McfSendPolicy, gate: 'preview' | 'dispatch' | 'read', spapiConnectionId: string, marketplaceId: string): boolean {
  if (!mcfScopeCovers(policy, spapiConnectionId, marketplaceId)) return false;
  if (gate === 'preview') return policy.previewEnabled;
  if (gate === 'dispatch') return policy.dispatchEnabled;
  return true;
}
