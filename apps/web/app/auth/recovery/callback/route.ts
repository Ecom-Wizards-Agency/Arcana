import { NextResponse } from 'next/server';
import { authOrigin } from '../../../../src/auth/origin';
import { safeNextPath } from '../../../../src/auth/next-path';
import { supabaseConfigured, supabaseServerClient } from '../../../../src/auth/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Complete already-issued recovery links even after new requests are disabled. */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const origin = authOrigin();
  const next = safeNextPath(url.searchParams.get('next'), '/dashboard');
  const retry = new URL('/forgot-password', origin);
  retry.search = new URLSearchParams({ error: 'link is no longer valid', next }).toString();
  const code = url.searchParams.get('code');
  if (!supabaseConfigured() || !code) {
    return NextResponse.redirect(retry);
  }

  const supabase = await supabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return NextResponse.redirect(retry);
  return NextResponse.redirect(new URL(`/recover-password?${new URLSearchParams({ next }).toString()}`, origin));
}
