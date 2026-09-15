import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { InvitationLanding } from '../../../src/invitations/landing';
import { acceptOwnerInvitation, verifyOwnerInvitationEmail } from './actions';

export const dynamic = 'force-dynamic';
// Native POSTs need a same-origin Origin header for Next's CSRF check. Suppress
// referrers to other origins without making same-origin form origins opaque.
export const metadata: Metadata = { referrer: 'same-origin', robots: { index: false, follow: false } };

export default async function AgencyInvitationPage({ params, searchParams }: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string; token_hash?: string }>;
}): Promise<ReactNode> {
  const { token } = await params;
  const query = await searchParams;
  return <InvitationLanding kind="agency" token={token} authToken={query.token_hash} error={query.error}
    acceptAction={acceptOwnerInvitation.bind(null, token)} verifyAction={verifyOwnerInvitationEmail.bind(null, token)} />;
}
