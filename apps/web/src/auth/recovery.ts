import { authFeatureConfig } from './config';
import { authOrigin } from './origin';
import { safeNextPath } from './next-path';
import { supabaseConfigured, supabaseServerClient } from './supabase';

export type RecoveryRequestResult =
  | { status: 'sent' }
  | { status: 'invalid'; message: string }
  | { status: 'disabled'; message: string };

/** Send a PKCE recovery link without exposing account or provider state. */
export async function requestPasswordRecovery(emailInput: string, requestedNext?: string): Promise<RecoveryRequestResult> {
  const email = emailInput.trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return { status: 'invalid', message: 'Enter a valid email address.' };
  }
  if (!authFeatureConfig().passwordRecovery || !supabaseConfigured()) {
    return { status: 'disabled', message: 'Password recovery is not available.' };
  }

  const callback = new URL('/auth/recovery/callback', authOrigin());
  callback.searchParams.set('next', safeNextPath(requestedNext, '/dashboard'));
  try {
    const supabase = await supabaseServerClient();
    await supabase.auth.resetPasswordForEmail(email, { redirectTo: callback.toString() });
  } catch {
    // Network failures and provider exceptions are nondisclosing too.
  }

  // Provider errors and unknown accounts intentionally produce the same result.
  return { status: 'sent' };
}
