/** `/login` — password-first sign-in for invited accounts. */
import type { ReactNode } from 'react';
import { authFeatureConfig } from '../../src/auth/config';
import { currentUser } from '../../src/auth/session';
import { safeNextPath } from '../../src/auth/next-path';
import { supabaseConfigured } from '../../src/auth/supabase';
import { Button, Field, Input } from '../../src/ui/primitives';
import { banner, heading, muted, page } from '../../src/ui/tokens';
import { signInWithGoogle, signInWithPassword } from './actions';
import { PasskeySignIn } from './passkey-button';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}): Promise<ReactNode> {
  const { error, next: requestedNext } = await searchParams;
  const next = safeNextPath(requestedNext, '/dashboard');
  const user = await currentUser();
  const config = authFeatureConfig();
  const passwordLoginEnabled = config.passwordLogin;

  return (
    <main style={{ ...page, maxWidth: '28rem' }}>
      <h1 style={heading}>OpenSpell</h1>
      <p style={muted}>Sign in to your workspace.</p>

      {error ? <p style={banner('bad')}>{error}</p> : null}
      {user ? (
        <p style={banner('good')}>
          You are already signed in. <a href={next}>Continue</a>.
        </p>
      ) : null}

      {supabaseConfigured() ? (
        <>
          {passwordLoginEnabled ? (
            <>
              <form action={signInWithPassword} style={{ display: 'grid', gap: '0.5rem' }}>
                <input type="hidden" name="next" value={next} />
                <Field label="Email" htmlFor="password-email">
                  <Input
                    id="password-email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                  />
                </Field>
                <Field label="Password" htmlFor="password">
                  <Input
                    id="password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                  />
                </Field>
                <Button type="submit">
                  Sign in
                </Button>
              </form>
            </>
          ) : (
            <p style={banner('warn')}>Password sign-in is temporarily unavailable.</p>
          )}

          {config.passwordRecovery ? (
            <p><a href={`/forgot-password?${new URLSearchParams({ next }).toString()}`}>Forgot password?</a></p>
          ) : null}

          {config.passkeyPolicy === 'sign-in' ? <PasskeySignIn next={next} /> : null}

          {config.googleLogin ? (
            <form action={signInWithGoogle} style={{ marginTop: '1rem' }}>
              <input type="hidden" name="next" value={next} />
              <Button type="submit">Continue with Google</Button>
            </form>
          ) : null}
        </>
      ) : (
        <p style={banner('warn')}>
          Supabase Auth is not configured on this instance. Set{' '}
          <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>;
          see <code>apps/web/env.TEMPLATE</code>.
        </p>
      )}
    </main>
  );
}
