import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { currentUser } from '../../src/auth/session';
import { safeNextPath } from '../../src/auth/next-path';
import { Card, PageHeader } from '../../src/ui/primitives';
import { page } from '../../src/ui/tokens';
import { RecoveryPasswordForm } from './password-form';

export const dynamic = 'force-dynamic';

export default async function RecoverPasswordPage({ searchParams }: {
  searchParams: Promise<{ next?: string }>;
}): Promise<ReactNode> {
  const next = safeNextPath((await searchParams).next, '/dashboard');
  if ((await currentUser()) === null) redirect(`/forgot-password?${new URLSearchParams({ error: 'link is no longer valid', next }).toString()}`);
  return (
    <main style={{ ...page, maxWidth: '30rem' }}>
      <PageHeader title="Replace password" subtitle="Choose a new password for this invited account." />
      <Card><RecoveryPasswordForm next={next} /></Card>
    </main>
  );
}
