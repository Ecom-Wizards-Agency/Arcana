/**
 * A strict, per-request nonce CSP for the Creator sample screens, where the
 * browser seals a creator's postal address before anything is posted. Only
 * scripts this origin serves, or that carry this request's nonce, may run, so
 * no third-party script can read the form.
 *
 * Next reads the nonce from the request's `Content-Security-Policy` header and
 * stamps it on its own scripts. The root layout also emits two scripts without
 * a nonce: the inline theme stamp, allowed here by its exact hash, and the
 * same-origin shell bootstrap, allowed by `'self'`. That second one is why
 * there is no `'strict-dynamic'`: it would make browsers ignore `'self'`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { THEME_SCRIPT } from './src/ui/theme-script';

export const config = { matcher: ['/creators/samples/:path*'] };

/** `'sha256-…'` of the inline theme script exactly as the layout renders it. */
export const THEME_SCRIPT_HASH_SOURCE =
  `'sha256-${createHash('sha256').update(THEME_SCRIPT, 'utf8').digest('base64')}'`;

export function creatorSamplesCsp(nonce: string, dev: boolean): string {
  return [
    "default-src 'self'",
    // React's development build needs eval for its error overlays; production does not.
    `script-src 'self' 'nonce-${nonce}' ${THEME_SCRIPT_HASH_SOURCE}${dev ? " 'unsafe-eval'" : ''}`,
    // Server-rendered React emits inline style attributes, which a nonce cannot
    // cover. Styles cannot read the form; scripts are the threat this policy blocks.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function proxy(request: NextRequest): NextResponse {
  const nonce = randomBytes(18).toString('base64');
  const csp = creatorSamplesCsp(nonce, process.env.NODE_ENV === 'development');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}
