import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { InvitationLanding } from '../../../src/invitations/landing';
import { acceptAsExistingUser, verifyInvitationEmail } from './actions';

export const dynamic = 'force-dynamic';
// Keep native forms compatible with Next's Origin check while withholding
// invitation URLs from every cross-origin referrer.
export const metadata: Metadata = { referrer: 'same-origin', robots: { index: false, follow: false } };

export default async function InvitationPage({ params, searchParams }: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string; token_hash?: string }>;
}): Promise<ReactNode> {
  const { token } = await params;
  const query = await searchParams;
  return <InvitationLanding kind="team" token={token} authToken={query.token_hash} error={query.error}
    acceptAction={acceptAsExistingUser.bind(null, token)} verifyAction={verifyInvitationEmail.bind(null, token)} />;
}
