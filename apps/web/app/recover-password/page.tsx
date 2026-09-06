import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { currentUser } from '../../src/auth/session';
import { safeNextPath } from '../../src/auth/next-path';
import { Card, PageHeader } from '../../src/ui/primitives';
import { page } from '../../src/ui/tokens';
import { RecoveryPasswordForm } from './password-form';

export const dynamic = 'force-dynamic';

export default async function RecoverPasswordPage({ searchParams }: {
  searchParams: Promise<{ next?: string; setup?: string }>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const next = safeNextPath(query.next, '/dashboard');
  const setup = query.setup === '1';
  if ((await currentUser()) === null) redirect(`/forgot-password?${new URLSearchParams({ error: 'link is no longer valid', next }).toString()}`);
  return (
    <main style={{ ...page, maxWidth: '30rem' }}>
      <PageHeader title={setup ? 'Set password' : 'Replace password'} subtitle="Choose a new password for this invited account." />
      <Card><RecoveryPasswordForm next={next} setup={setup} /></Card>
    </main>
  );
}
