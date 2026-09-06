import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { Suspense, type ReactNode } from 'react';
import '../src/ui/theme.css';
import { AppNav, NavBar } from '../src/ui/nav';
import { BugWidget } from '../src/ui/bug-widget';
import { ToastProvider } from '../src/ui/toast';
import { THEME_SCRIPT } from '../src/ui/theme-script';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
});

/**
 * The origin social cards are resolved against, when the deployment declares
 * one. `authOrigin` deliberately throws without it in production because a
 * wrong auth link is a security problem; a wrong `og:image` base is not, so
 * this reads the same variable and stays quiet. Unset, Next falls back to the
 * deployment URL, which is right everywhere except a custom domain.
 */
function socialOrigin(): URL | undefined {
  const configured = process.env['WIZARD_ADS_APP_URL'];
  if (configured === undefined || configured === '' || !URL.canParse(configured)) return undefined;
  return new URL(configured);
}

const metadataBase = socialOrigin();

/**
 * `app/icon.png`, `app/apple-icon.png` and `app/opengraph-image.png` are Next
 * metadata files, rasterised from `public/brand/wizards-ai-icon.svg`, which
 * stays the source of truth for the mark. The convention gives each one a
 * route; whether the tag reaches the head is decided here, and the two fields
 * below behave in opposite ways.
 *
 * `icons` must name the icon files, because Next merges the collected
 * file-convention icons only when this object declares no `icons` at all
 * (`resolve-metadata.js`, the `if (!resolvedMetadata.icons)` guard). Declaring
 * the vector alone therefore *suppressed* both PNGs. Listing all three keeps
 * the SVG for browsers that prefer it and the PNGs for everything else.
 *
 * `openGraph` must not name the card, for the mirror-image reason: the static
 * image is adopted unless this object owns an `images` key, so adding one would
 * replace a 1200x630 PNG with whatever was named. The absence is load-bearing.
 */
export const metadata: Metadata = {
  ...(metadataBase === undefined ? {} : { metadataBase }),
  title: 'OpenSpell',
  description: 'Amazon Advertising operator workspace',
  applicationName: 'OpenSpell',
  icons: {
    icon: [
      { url: '/icon.png', type: 'image/png', sizes: '512x512' },
      { url: '/brand/wizards-ai-icon.svg', type: 'image/svg+xml' },
    ],
    apple: [{ url: '/apple-icon.png', type: 'image/png', sizes: '180x180' }],
  },
  openGraph: {
    type: 'website',
    siteName: 'OpenSpell',
    title: 'OpenSpell',
    description: 'Amazon Advertising operator workspace',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'OpenSpell',
    description: 'Amazon Advertising operator workspace',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#FFFFFF' },
    { media: '(prefers-color-scheme: dark)', color: '#0F1318' },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { currentUser } = await import('../src/auth/session');
  const user = await currentUser();
  let feedbackEnabled = user !== null;

  // The production-style Playwright suite authenticates with the deliberately
  // isolated header bridge rather than a Supabase cookie. Recognise that
  // already-verified test actor here so the suite still exercises the widget;
  // the bridge refuses to arm alongside a real auth provider.
  if (!feedbackEnabled) {
    const { actorFromHeaders, e2eAuthBridgeEnabled, RequestAuthError } = await import(
      '../src/server/request-context'
    );
    if (e2eAuthBridgeEnabled()) {
      const { headers } = await import('next/headers');
      try {
        actorFromHeaders(await headers());
        feedbackEnabled = true;
      } catch (error) {
        // Playwright's web-server readiness probe does not carry the browser
        // context's auth headers. It must be allowed to receive the anonymous
        // frame; invalid bridge configuration (503) still fails the request.
        if (!(error instanceof RequestAuthError && error.status === 401)) throw error;
      }
    }
  }

  return (
    // The theme stamp below rewrites `data-theme` before React sees the
    // document, which is exactly the mismatch this attribute exists for.
    <html lang="en" data-theme="light" className={inter.variable} suppressHydrationWarning>
      <head>
        {/*
          Before first paint, not after hydration: a dark-mode user who watches
          the app flash white on every navigation does not have dark mode, they
          have an apology.
        */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <ToastProvider>
          {/*
            The layout reads the session once for the frame. Anonymous screens
            get a quiet public header and no unreachable operator navigation;
            authenticated screens get the complete operator frame. Every route
            remains dynamic, which is correct for a per-tenant tool.
          */}
          <Suspense fallback={<NavBar user={user} />}>
            <AppNav user={user} />
          </Suspense>
          <div
            className={user === null ? 'wa-content wa-content--public' : 'wa-content'}
            id="wa-main"
          >
            {process.env['WIZARD_ADS_REVIEW_LIVE_DATA'] === '1' ? (
              <p role="status" data-testid="review-live-data" style={{ margin: '1rem 1.5rem 0', fontWeight: 600 }}>
                Review · live data
              </p>
            ) : null}
            {children}
          </div>
          {/*
            The bug reporter is an operator control. Gating it on a verified
            session (or the isolated e2e bridge) prevents an anonymous hydration
            flash on /login while preserving the signed-in browser workflow.
          */}
          {feedbackEnabled ? (
            <BugWidget appVersion={process.env['WIZARD_ADS_APP_VERSION'] ?? null} />
          ) : null}
        </ToastProvider>
      </body>
    </html>
  );
}
