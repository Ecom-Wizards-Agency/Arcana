/**
 * Operator copy for a refused Seller Central consent start.
 *
 * The start route and the Connections screen both read this table: the route
 * for its JSON body, the screen for the code carried by its redirect. The URL
 * holds only fixed codes, so the screen never echoes request, provider,
 * database or environment text.
 */
import { SpApiStartRefusal, type SpApiStartDatabaseRefusal, type SpApiStartField } from '@wizard-ads/shared';

/** The web settings a configuration refusal may name. Shared only fixes the name's shape. */
export const SP_API_START_SETTINGS = [
  'OPENSPELL_SPAPI_CONNECTIONS_ENABLED', 'SP_API_LWA_CLIENT_ID', 'SP_API_APPLICATION_ID', 'SP_API_OAUTH_REDIRECT_URI',
  'SP_API_OAUTH_REGION', 'SP_API_TEST_CONSENT_URL', 'AMAZON_OAUTH_STATE_KEY', 'WIZARD_ADS_APP_URL', 'DATABASE_URL',
  'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'WIZARD_ADS_PASSWORD_LOGIN', 'WIZARD_ADS_PASSWORD_RECOVERY',
  'WIZARD_ADS_GOOGLE_LOGIN', 'WIZARD_ADS_TOTP_POLICY', 'WIZARD_ADS_PASSKEYS',
] as const;
export type SpApiStartSettingName = (typeof SP_API_START_SETTINGS)[number];
export const isSpApiStartSetting = (value: unknown): value is SpApiStartSettingName =>
  SP_API_START_SETTINGS.some((setting) => setting === value);

/** Exact SQLSTATE and message pairs raised by the begin command's migrations. */
export const SP_API_START_DATABASE_REFUSALS: Readonly<Record<SpApiStartDatabaseRefusal, { sqlstate: string; text: string }>> = {
  manager_required: { sqlstate: '42501', text: 'Resource not found' },
  invalid_installation: { sqlstate: '22023', text: 'Invalid SP-API installation' },
  request_reused: { sqlstate: '22023', text: 'Connection request identity already used' },
  invalid_selection: { sqlstate: '22023', text: 'Invalid SP-API selection' },
  duplicate_profiles: { sqlstate: '22023', text: 'Duplicate SP-API profiles' },
  association_refused: { sqlstate: '42501', text: 'SP-API profile association refused' },
  reconnect_scope: { sqlstate: '42501', text: 'Reconnect scope must match the existing connection' },
  reconnect_bindings: { sqlstate: '42501', text: 'Reconnect must include every existing profile binding' },
  profile_taken: { sqlstate: '42501', text: 'Profile already belongs to another connection' },
};

const selectionMessages: Readonly<Record<SpApiStartField, string>> = {
  org: 'The selected agency is not valid. Reload Connections and start again.',
  label: 'Enter a seller connection label of 1 to 256 characters.',
  bindings: 'Select between 1 and 50 seller profiles, each profile once, then start again.',
  form: 'The connection form was too large. Select fewer profiles and start again.',
};

export function spApiStartRefusalMessage(value: SpApiStartRefusal): string {
  switch (value.refusal) {
    case 'origin':
      return 'The request did not come from this installation\'s configured address. Open Arcana at its usual address and start again.';
    case 'unavailable':
      return 'Seller connections are unavailable. Contact your installation operator.';
    case 'session':
      return 'Your sign-in or account security could not be verified. Sign in again to continue.';
    case 'role':
      return 'Your role in this agency cannot manage seller connections. Ask an owner or admin.';
    case 'configuration':
      return `Seller connections are not fully configured: ${value.detail} is missing or invalid. Contact your installation operator.`;
    case 'selection':
      return selectionMessages[value.detail];
    case 'signing_key':
      return 'The connection signing key (AMAZON_OAUTH_STATE_KEY) is missing or shorter than 32 bytes. Contact your installation operator.';
    case 'database':
      return value.detail === null
        ? 'The database refused to start this connection. Try again; if it repeats, contact your installation operator.'
        : `The database refused this connection: ${SP_API_START_DATABASE_REFUSALS[value.detail].text}.`;
    case 'unexpected':
      return 'The connection could not be started because of an unexpected server error. Try again; if it repeats, contact your installation operator.';
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

/** Parse the redirect's two query values; anything outside the fixed codes is refused. */
export function parseSpApiStartRefusal(error: unknown, detail: unknown): SpApiStartRefusal | null {
  const parsed = SpApiStartRefusal.safeParse({ refusal: error, detail: detail ?? null });
  if (!parsed.success) return null;
  return parsed.data.refusal === 'configuration' && !isSpApiStartSetting(parsed.data.detail) ? null : parsed.data;
}
