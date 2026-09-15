/**
 * Server environment, read in one place.
 *
 * Two rules this file exists to keep:
 *
 *  - **Secrets are server-only.** The state signing key
 *    and the database URL are read here and nowhere a bundle can reach. Only
 *    `NEXT_PUBLIC_*` values cross to the browser, and the two that do are the
 *    Supabase URL and anon key, which are public by design.
 *  - **A missing variable names itself.** A driver error six frames deep costs
 *    an hour; naming the missing variable costs a minute.
 *
 * The Amazon endpoints are configurable with real defaults. That is not
 * indirection for its own sake: the end-to-end test points them at a local
 * mock, which is the only way to exercise the callback without a live grant.
 */
import { AmazonConnectionInstallation } from '@wizard-ads/shared';

export function required(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set. See apps/web/env.TEMPLATE.`);
  return value;
}

export function optional(
  name: string,
  fallback: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env[name] || fallback;
}

/**
 * The MCP endpoint an operator pastes into their client.
 *
 * Never derive this from `WIZARD_ADS_APP_URL`. The MCP server is a separate
 * deploy target — `apps/mcp`, exposed through its own managed tunnel — while
 * the web app serves no `/mcp` route at all.
 * Appending `/mcp` to the app origin therefore produces a URL that looks right,
 * copies cleanly off `/connect-claude`, and 404s.
 *
 * `WIZARD_ADS_MCP_URL` is the same name `apps/analyst` already reads, so one
 * value configures both consumers.
 */
export function mcpEndpoint(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env['NEXT_PUBLIC_MCP_URL']?.trim() || env['WIZARD_ADS_MCP_URL']?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Web only constructs the consent redirect; token exchange belongs to the worker. */
export interface AmazonOAuthConfig extends AmazonConnectionInstallation {
  authorizeUrl: string;
}

export function amazonConnectionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['OPENSPELL_AMAZON_CONNECTIONS_ENABLED'] === '1';
}

export function amazonOAuthConfig(env: NodeJS.ProcessEnv = process.env): AmazonOAuthConfig {
  const installation = AmazonConnectionInstallation.safeParse({
    clientId: required('AMAZON_LWA_CLIENT_ID', env),
    redirectUri: required('AMAZON_OAUTH_REDIRECT_URI', env),
    // The one scope the tool needs. Widening it is a deliberate act, not a
    // default, so it is written here rather than read from the environment.
    scope: 'advertising::campaign_management',
  });
  if (!installation.success) throw new Error('Amazon consent configuration is invalid');
  const authorizeUrl = optional('AMAZON_LWA_AUTHORIZE_URL', 'https://www.amazon.com/ap/oa', env);
  const url = new URL(authorizeUrl);
  if (url.username || url.password || url.hash || !(url.protocol === 'https:'
    || (url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) {
    throw new Error('Amazon consent endpoint is invalid');
  }
  return { ...installation.data, authorizeUrl };
}

/** HMAC key for the OAuth `state`. Length is enforced where it is used. */
export function stateSigningKey(env: NodeJS.ProcessEnv = process.env): string {
  return required('AMAZON_OAUTH_STATE_KEY', env);
}

/**
 * Is this deployment served over https? Decides whether the nonce cookie can
 * carry the `__Host-` prefix, which browsers refuse over plain http.
 */
export function secureCookies(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = env['WIZARD_ADS_SECURE_COOKIES'];
  if (explicit === '1') return true;
  if (explicit === '0') return false;
  return env['NODE_ENV'] === 'production';
}
