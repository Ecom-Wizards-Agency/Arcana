import type { ReactNode } from 'react';
import { authFeatureConfig } from '../../src/auth/config';
import { supabaseConfigured } from '../../src/auth/supabase';
import { safeNextPath } from '../../src/auth/next-path';
import { Banner, Card, LinkButton, PageHeader } from '../../src/ui/primitives';
import { page } from '../../src/ui/tokens';
import { RecoveryForm } from './recovery-form';

export const dynamic = 'force-dynamic';

export default async function ForgotPasswordPage({ searchParams }: {
  searchParams: Promise<{ next?: string }>;
}): Promise<ReactNode> {
  const next = safeNextPath((await searchParams).next, '/dashboard');
  const enabled = authFeatureConfig().passwordRecovery && supabaseConfigured();
  return (
    <main style={{ ...page, maxWidth: '30rem' }}>
      <PageHeader title="Recover password" subtitle="Request a single-use link for an invited account." />
      <Card>
        {enabled ? (
          <RecoveryForm next={next} />
        ) : (
          <Banner tone="warn">Password recovery is not available on this instance.</Banner>
        )}
        <div style={{ marginTop: '1rem' }}>
          <LinkButton href={`/login?${new URLSearchParams({ next }).toString()}`} variant="ghost">Back to sign in</LinkButton>
        </div>
      </Card>
    </main>
  );
}
