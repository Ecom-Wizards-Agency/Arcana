import { NextResponse } from 'next/server';
import { authOrigin } from '../../../../src/auth/origin';
import { safeNextPath } from '../../../../src/auth/next-path';
import { supabaseConfigured, supabaseServerClient } from '../../../../src/auth/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TOKEN_HASH = /^[A-Za-z0-9_-]{16,256}$/;

function retryUrl(origin: string, next: string): URL {
  const retry = new URL('/forgot-password', origin);
  retry.search = new URLSearchParams({ error: 'link is no longer valid', next }).toString();
  return retry;
}

/**
 * Complete already-issued recovery links even after new requests are disabled.
 * Email links arrive with a PKCE `code`. An owner/admin-issued link carries a
 * one-time `token_hash`; its GET only renders a confirmation form, so a link
 * preview or scanner cannot consume the token.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const origin = authOrigin();
  const next = safeNextPath(url.searchParams.get('next'), '/dashboard');
  const tokenHash = url.searchParams.get('token_hash');
  if (tokenHash !== null && !url.searchParams.has('code')) {
    if (!supabaseConfigured() || !TOKEN_HASH.test(tokenHash)) return NextResponse.redirect(retryUrl(origin, next));
    return confirmation(tokenHash, next);
  }
  const code = url.searchParams.get('code');
  if (!supabaseConfigured() || !code) {
    return NextResponse.redirect(retryUrl(origin, next));
  }

  const supabase = await supabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return NextResponse.redirect(retryUrl(origin, next));
  return NextResponse.redirect(new URL(`/recover-password?${new URLSearchParams({ next }).toString()}`, origin));
}

/** Explicit same-origin POST verifies an issued reset link exactly once. */
export async function POST(request: Request): Promise<Response> {
  const origin = authOrigin();
  if (request.headers.get('origin') !== origin) return new Response('Forbidden', { status: 403 });
  let form: FormData;
  try { form = await request.formData(); } catch { return NextResponse.redirect(retryUrl(origin, '/dashboard'), 303); }
  const rawNext = form.get('next');
  const next = safeNextPath(typeof rawNext === 'string' ? rawNext : null, '/dashboard');
  const tokenHash = form.get('token_hash');
  if (!supabaseConfigured() || typeof tokenHash !== 'string' || !TOKEN_HASH.test(tokenHash)) {
    return NextResponse.redirect(retryUrl(origin, next), 303);
  }
  let verified = false;
  try {
    const client = await supabaseServerClient();
    const initialized = await client.auth.initialize();
    if (!initialized.error) {
      const result = await client.auth.verifyOtp({ token_hash: tokenHash, type: 'recovery' });
      verified = !result.error && result.data.session !== null && result.data.user !== null;
      if (!verified && result.data.session !== null) await client.auth.signOut({ scope: 'local' });
    }
  } catch {
    // Provider errors may contain tokens. A lost response is never retried here.
  }
  if (!verified) return NextResponse.redirect(retryUrl(origin, next), 303);
  return NextResponse.redirect(new URL(`/recover-password?${new URLSearchParams({ next }).toString()}`, origin), 303);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

function confirmation(tokenHash: string, next: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Choose a new password</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 30rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5;">
<h1 style="font-size: 1.4rem;">Choose a new password</h1>
<p>This reset link was created for you by an owner or admin of your Arcana workspace. It works once.</p>
<form method="post" action="/auth/recovery/callback">
<input type="hidden" name="token_hash" value="${escapeHtml(tokenHash)}">
<input type="hidden" name="next" value="${escapeHtml(next)}">
<button type="submit">Continue to set a new password</button>
</form>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // Same-origin keeps the POST's Origin header while withholding the URL
      // from any other origin.
      'referrer-policy': 'same-origin',
      'x-robots-tag': 'noindex, nofollow',
      'x-frame-options': 'DENY',
    },
  });
}
