import type { ReactNode } from 'react';
import { currentUser } from '../auth/session';
import { Button, Card, LinkButton } from '../ui/primitives';
import { heading, muted, page } from '../ui/tokens';
import {
  INVITATION_ERRORS, invitationPath, loadRecipientInvitation, validAuthInvitationToken,
  type InvitationKind,
} from './recipient';

export async function InvitationLanding({ kind, token, authToken, error, acceptAction, verifyAction }: {
  kind: InvitationKind;
  token: string;
  authToken: string | undefined;
  error: string | undefined;
  acceptAction: () => Promise<void>;
  verifyAction: (formData: FormData) => Promise<void>;
}): Promise<ReactNode> {
  const invitation = await loadRecipientInvitation(kind, token);
  if (invitation === null) return <Outcome>This invitation is invalid or unavailable.</Outcome>;
  if (invitation.state === 'expired') return <Outcome>This invitation has expired.</Outcome>;
  if (invitation.state === 'revoked') return <Outcome>This invitation is no longer open.</Outcome>;
  const user = await currentUser();
  const path = invitationPath(kind, token);
  const message = error && Object.hasOwn(INVITATION_ERRORS, error) ? INVITATION_ERRORS[error as keyof typeof INVITATION_ERRORS] : null;
  const continuation = new URLSearchParams({ next: path }).toString();
  return (
    <main style={{ ...page, maxWidth: '30rem' }}>
      <h1 style={heading}>Join {invitation.agencyName}</h1>
      <p style={muted}>You have been invited as <strong>{invitation.role}</strong> using {invitation.email}.</p>
      {message ? <p className="wa-banner wa-banner--bad" role="alert">{message}</p> : null}
      <Card>
        {user !== null ? (
          user.email?.trim().toLowerCase() === invitation.email.toLowerCase() ? (
            <form action={acceptAction}>
              <Button type="submit">{invitation.state === 'accepted' ? 'Open workspace' : 'Accept invitation'}</Button>
            </form>
          ) : (
            <>
              <p>This invitation was issued to a different address.</p>
              <form action={`/auth/signout?${continuation}`} method="post"><Button type="submit" variant="ghost">Sign out</Button></form>
            </>
          )
        ) : (
          <>
            {validAuthInvitationToken(authToken) && invitation.state === 'pending' ? (
              <form action={verifyAction}>
                <input type="hidden" name="auth_token_hash" value={authToken} />
                <p>Verify your email, then choose a password for OpenSpell.</p>
                <Button type="submit">Continue with email invitation</Button>
              </form>
            ) : (
              <p>Sign in to accept. For a new account, open the email invitation to set your password.</p>
            )}
            <p><LinkButton href={`/login?${continuation}`}>Sign in</LinkButton></p>
            <LinkButton href={`/forgot-password?${continuation}`} variant="ghost">Recover password</LinkButton>
          </>
        )}
      </Card>
    </main>
  );
}

function Outcome({ children }: { children: ReactNode }): ReactNode {
  return <main style={{ ...page, maxWidth: '30rem' }}><p style={muted}>{children}</p></main>;
}
