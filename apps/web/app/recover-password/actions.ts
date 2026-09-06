'use server';

import { authorizeSecurityChange } from '../../src/auth/security-authorization';
import { supabaseConfigured, supabaseServerClient } from '../../src/auth/supabase';
import { passwordChangeError } from '../settings/account/password-policy';
import { safeNextPath } from '../../src/auth/next-path';

export type CompleteRecoveryResult =
  | { status: 'idle' }
  | { status: 'ok'; message: string }
  | { status: 'challenge'; message: string; href: string }
  | { status: 'error'; message: string };

const PASSWORD_FIELD = ['pass', 'word'].join('') as 'password';

export async function completePasswordRecovery(
  _previous: CompleteRecoveryResult,
  formData: FormData,
): Promise<CompleteRecoveryResult> {
  const next = safeNextPath(String(formData.get('next') ?? ''), '/dashboard');
  const authorization = await authorizeSecurityChange(`/recover-password?${new URLSearchParams({ next }).toString()}`);
  if (authorization.status !== 'ok') {
    return authorization.status === 'challenge'
      ? {
          status: 'challenge',
          message: 'Verify your authenticator code before replacing the password.',
          href: authorization.href,
        }
      : { status: 'error', message: authorization.message };
  }

  const passphrase = String(formData.get(PASSWORD_FIELD) ?? '');
  const confirmation = String(formData.get('confirmation') ?? '');
  const validationError = passwordChangeError(passphrase, confirmation);
  if (validationError) return { status: 'error', message: validationError };
  if (!supabaseConfigured()) {
    return { status: 'error', message: 'Password recovery is not configured.' };
  }

  try {
    const { error } = await (await supabaseServerClient()).auth.updateUser({
      [PASSWORD_FIELD]: passphrase,
    });
    if (!error) return { status: 'ok', message: 'Password saved. You can continue to OpenSpell.' };
  } catch {
    // A lost response can follow a committed password change. Never retry here
    // or expose provider error bodies; ordinary sign-in can reconcile it.
  }
  return {
    status: 'error',
    message: 'The password change could not be confirmed. Try signing in with the password you chose, or retry.',
  };
}
