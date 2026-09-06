import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/auth/session', () => ({ currentUser: async () => null }));
vi.mock('../../src/auth/supabase', () => ({ supabaseConfigured: () => true }));
vi.mock('./actions', () => ({ signInWithPassword: vi.fn(), signInWithGoogle: vi.fn() }));

import LoginPage from './page';

describe('password-first login', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('offers email/password and recovery by default without an email-link action', async () => {
    vi.stubEnv('WIZARD_ADS_PASSWORD_LOGIN', undefined);
    vi.stubEnv('WIZARD_ADS_PASSWORD_RECOVERY', undefined);
    vi.stubEnv('WIZARD_ADS_GOOGLE_LOGIN', undefined);
    vi.stubEnv('WIZARD_ADS_PASSKEYS', undefined);
    const markup = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({}) }));
    expect(markup).toContain('type="email"');
    expect(markup).toContain('type="password"');
    expect(markup).toContain('autoComplete="current-password"');
    expect(markup).toContain('href="/forgot-password?next=%2Fdashboard"');
    expect(markup.match(/<form/g)).toHaveLength(1);
    expect(markup).not.toMatch(/magic link|email link|sign up|Google|passkey/i);
  });
});
