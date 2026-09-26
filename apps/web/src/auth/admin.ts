/**
 * The one service-role Supabase client in the web tier.
 *
 * It exists solely for manager-authorized invitation delivery (email, or a
 * one-time link returned to the manager) and owner/admin-issued reset links.
 * It never preconfirms an email or sets a recipient's password. Application
 * data uses Postgres, and session cookies still go through the anon server
 * client in `supabase.ts`.
 */
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { required } from '../env';

const ADMIN_TIMEOUT_MS = 10_000;

export function supabaseAdminClient(): SupabaseClient {
  return createClient(
    required('NEXT_PUBLIC_SUPABASE_URL'),
    required('SUPABASE_SERVICE_ROLE_KEY'),
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      // Link issuance waits on this call while holding the organisation
      // member lock. Bound it; a timeout is reported as uncertain.
      global: {
        fetch: (input, init) => fetch(input, {
          ...init,
          signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(ADMIN_TIMEOUT_MS)]) : AbortSignal.timeout(ADMIN_TIMEOUT_MS),
        }),
      },
    },
  );
}

/** Both values are required; the service key without its project URL is inert. */
export function supabaseAdminConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env['NEXT_PUBLIC_SUPABASE_URL'] && env['SUPABASE_SERVICE_ROLE_KEY']);
}

export type GeneratedAuthLink =
  | { status: 'ok'; tokenHash: string }
  | { status: 'existing_account' | 'failed' | 'uncertain' };

/**
 * Ask Auth for a one-time verification token without sending email. `invite`
 * creates the account when it is missing; `recovery` needs an existing one.
 * Only the token hash is returned: the application builds its own link so the
 * recipient's GET never consumes it. Never log the result or provider errors.
 */
export async function generateAuthLink(
  type: 'invite' | 'recovery', email: string, redirectTo: string,
): Promise<GeneratedAuthLink> {
  try {
    const result = await supabaseAdminClient().auth.admin.generateLink({ type, email, options: { redirectTo } });
    if (result.error?.code === 'email_exists' || result.error?.code === 'user_already_exists') return { status: 'existing_account' };
    if (result.error) return { status: !result.error.status || result.error.status >= 500 ? 'uncertain' : 'failed' };
    const tokenHash = result.data.properties?.hashed_token;
    const sameUser = result.data.user?.email?.trim().toLowerCase() === email.trim().toLowerCase();
    return typeof tokenHash === 'string' && /^[A-Za-z0-9_-]{16,256}$/.test(tokenHash) && sameUser
      ? { status: 'ok', tokenHash } : { status: 'uncertain' };
  } catch {
    // A request may have been accepted before its response was lost.
    return { status: 'uncertain' };
  }
}
