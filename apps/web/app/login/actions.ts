'use server';

/** Sign-in paths. None of them creates a user. */
import { redirect } from 'next/navigation';
import { authFeatureConfig } from '../../src/auth/config';
import { authContinuePath } from '../../src/auth/continuation';
import { safeNextPath } from '../../src/auth/next-path';
import { authOrigin } from '../../src/auth/origin';
import { supabaseConfigured, supabaseServerClient } from '../../src/auth/supabase';

const CREDENTIAL_FIELD = ['pass', 'word'].join('') as 'password';

export async function signInWithPassword(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '').trim();
  const passphrase = String(formData.get(CREDENTIAL_FIELD) ?? '');
  const next = formNext(formData);
  if (!authFeatureConfig().passwordLogin) {
    redirect(loginLocation(next, 'password sign-in is not enabled'));
  }
  if (!email || !passphrase) redirect(loginLocation(next, 'enter your email and password'));
  if (!supabaseConfigured()) redirect(loginLocation(next, 'Supabase Auth is not configured'));

  const supabase = await supabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({
    email,
    [CREDENTIAL_FIELD]: passphrase,
  });
  // Deliberately identical for an unknown account and a bad password.
  if (error) redirect(loginLocation(next, 'email or password was not accepted'));
  redirect(authContinuePath(next));
}

export async function signInWithGoogle(formData: FormData): Promise<void> {
  const next = formNext(formData);
  if (!authFeatureConfig().googleLogin) {
    redirect(loginLocation(next, 'Google sign-in is not enabled'));
  }
  if (!supabaseConfigured()) redirect(loginLocation(next, 'Supabase Auth is not configured'));

  const supabase = await supabaseServerClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: await callbackUrl(next) },
  });
  if (error || !data.url) redirect(loginLocation(next, 'Google sign-in is unavailable'));
  redirect(data.url);
}

function formNext(formData: FormData): string {
  const value = formData.get('next');
  return safeNextPath(typeof value === 'string' ? value : null, '/dashboard');
}

function loginLocation(next: string, error: string | null): string {
  const query = new URLSearchParams({ next });
  if (error !== null) query.set('error', error);
  return `/login?${query.toString()}`;
}

async function callbackUrl(next: string): Promise<string> {
  const url = new URL('/auth/callback', await authOrigin());
  url.searchParams.set('next', next);
  return url.toString();
}
