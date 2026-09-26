'use client';
import { formatShellDate } from '../../../src/ui/date-format';

import { useActionState, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ORG_ROLES } from '../../../src/auth/roles';
import type { OrgRole } from '../../../src/auth/roles';
import type { InvitationRecord } from '../../../src/data/invitations';
import type { MemberRecord } from '../../../src/data/members';
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Select,
  TableFrame,
} from '../../../src/ui/primitives';
import {
  changeMemberRole,
  createInvite,
  createResetLink,
  removeOrgMember,
  revokeInvite,
  sendInviteEmail,
} from './actions';
import type { EmailDeliveryResult, InviteActionResult, MemberActionResult, ResetLinkResult } from './actions';

const IDLE: MemberActionResult = { status: 'idle' };
const IDLE_INVITE: InviteActionResult = { status: 'idle' };
const IDLE_EMAIL: EmailDeliveryResult = { status: 'idle' };
const IDLE_RESET: ResetLinkResult = { status: 'idle' };

export function MembersManager({
  actor,
  members,
  invitations,
}: {
  actor: { id: string; role: OrgRole };
  members: readonly MemberRecord[];
  invitations: readonly InvitationRecord[];
}): ReactNode {
  const ownerCount = members.filter((member) => member.role === 'owner').length;
  const invitedBy = new Map(members.map((member) => [member.userId, member.email ?? 'Unknown member']));

  return (
    <div className="wa-stack">
      <InviteForm />

      <Card
        title="Members"
        subtitle={`${members.length} ${members.length === 1 ? 'person' : 'people'} with access`}
        flush
      >
        {members.length === 0 ? (
          <EmptyState
            title="No members"
            body="This organisation has no roster rows. Restore an owner before making other changes."
          />
        ) : (
          <TableFrame>
            <table className="wa-table wa-table--numeric">
              <thead>
                <tr>
                  <th scope="col">Email</th>
                  <th scope="col">Role</th>
                  <th scope="col">Joined</th>
                  <th scope="col"><span className="wa-sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <MemberRow
                    key={member.userId}
                    actor={actor}
                    member={member}
                    soleOwner={member.role === 'owner' && ownerCount === 1}
                  />
                ))}
              </tbody>
            </table>
          </TableFrame>
        )}
      </Card>

      <Card
        title="Pending invitations"
        subtitle={`${invitations.length} open`}
        flush
      >
        {invitations.length === 0 ? (
          <EmptyState
            title="No pending invitations"
            body="New invitations appear here until they are accepted, revoked, or expire."
          />
        ) : (
          <TableFrame>
            <table className="wa-table wa-table--numeric">
              <thead>
                <tr>
                  <th scope="col">Email</th>
                  <th scope="col">Role</th>
                  <th scope="col">Token</th>
                  <th scope="col">Expires</th>
                  <th scope="col">Invited by</th>
                  <th scope="col"><span className="wa-sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {invitations.map((invitation) => (
                  <InvitationRow
                    key={invitation.id}
                    invitation={invitation}
                    inviter={
                      invitation.invitedBy === null
                        ? '—'
                        : invitedBy.get(invitation.invitedBy) ?? 'Former member'
                    }
                  />
                ))}
              </tbody>
            </table>
          </TableFrame>
        )}
      </Card>
    </div>
  );
}

function InviteForm(): ReactNode {
  const [result, action, pending] = useActionState(createInvite, IDLE_INVITE);
  const [dismissedUrl, setDismissedUrl] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (result.status === 'ok') formRef.current?.reset();
  }, [result]);

  const visibleUrl = result.status === 'ok' && dismissedUrl !== result.inviteUrl;

  return (
    <Card
      title="Invite someone"
      subtitle="Links stay open for seven days and can be used once."
    >
      <form
        ref={formRef}
        action={action}
        className="wa-row"
        style={{ alignItems: 'flex-end', gap: '0.75rem' }}
      >
        <Field label="Email" htmlFor="invite-email" grow>
          <Input
            id="invite-email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="person@example.com"
            required
            disabled={pending}
          />
        </Field>
        <Field label="Role" htmlFor="invite-role">
          <Select id="invite-role" name="role" defaultValue="viewer" disabled={pending}>
            <option value="viewer">Viewer</option>
            <option value="analyst">Analyst</option>
            <option value="admin">Admin</option>
          </Select>
        </Field>
        <Button type="submit" variant="primary" disabled={pending} data-testid="create-invite">
          {pending ? 'Inviting…' : 'Invite'}
        </Button>
      </form>

      {result.status === 'error' ? (
        <Banner tone="bad" role="alert" data-testid="invite-error">
          {result.message}
        </Banner>
      ) : null}

      {visibleUrl && result.status === 'ok' ? (
        <OnceLink
          key={result.inviteUrl}
          url={result.inviteUrl}
          urlTestId="invite-url"
          status={result.deliveryLabel}
          statusTestId="invite-delivery-status"
          instruction={result.message}
          onDone={() => setDismissedUrl(result.inviteUrl)}
        >
          <EmailFallback key={result.token} token={result.token} replacesLink={result.delivery === 'link_ready'} />
        </OnceLink>
      ) : null}
    </Card>
  );
}

/** A bearer link shown once, with copy and dismiss controls. */
function OnceLink({
  url,
  urlTestId,
  status,
  statusTestId,
  instruction,
  onDone,
  children,
}: {
  url: string;
  urlTestId: string;
  status?: string;
  statusTestId?: string;
  instruction: string;
  onDone: () => void;
  children?: ReactNode;
}): ReactNode {
  const [copied, setCopied] = useState(false);
  return (
    <div className="wa-banner wa-banner--good" style={{ display: 'block', marginTop: '0.75rem' }}>
      {status ? (
        <p style={{ margin: 0 }}>
          <Badge tone="info" data-testid={statusTestId}>{status}</Badge>
        </p>
      ) : null}
      <p style={{ margin: '0.5rem 0 0' }} data-testid={`${urlTestId}-instruction`}>{instruction}</p>
      <div className="wa-row" style={{ marginTop: '0.5rem' }}>
        <code
          data-testid={urlTestId}
          style={{ flex: '1 1 24rem', overflowWrap: 'anywhere' }}
        >
          {url}
        </code>
        <Button
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(url).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Done
        </Button>
      </div>
      {children}
    </div>
  );
}

/** Secondary path: works once the installation has SMTP, fails visibly without it. */
function EmailFallback({ token, replacesLink }: { token: string; replacesLink: boolean }): ReactNode {
  const [result, action, pending] = useActionState(sendInviteEmail, IDLE_EMAIL);
  return (
    <form action={action} style={{ marginTop: '0.75rem' }}>
      <input type="hidden" name="token" value={token} />
      <Button type="submit" size="sm" variant="ghost" disabled={pending || result.status === 'ok'} data-testid="invite-send-email">
        {pending ? 'Sending…' : 'Also send by email'}
      </Button>
      {replacesLink && result.status === 'idle' ? (
        <span className="wa-hint" style={{ display: 'block', marginTop: '0.25rem' }}>
          Sending the email replaces the link above; they must then use the email.
        </span>
      ) : null}
      {result.status === 'idle' ? null : (
        <span
          className={`wa-hint${result.status === 'error' || result.delivery !== 'accepted_by_provider' ? ' wa-text-bad' : ''}`}
          role={result.status === 'error' || result.delivery !== 'accepted_by_provider' ? 'alert' : 'status'}
          data-testid="invite-email-status"
          style={{ display: 'block', marginTop: '0.25rem' }}
        >
          {result.status === 'ok' ? `${result.label}. ${result.message}` : result.message}
          {replacesLink && result.status === 'ok' && (result.delivery === 'failed' || result.delivery === 'uncertain')
            ? ' The link above may no longer work; revoke this invitation and invite again.' : null}
        </span>
      )}
    </form>
  );
}

function MemberRow({
  actor,
  member,
  soleOwner,
}: {
  actor: { id: string; role: OrgRole };
  member: MemberRecord;
  soleOwner: boolean;
}): ReactNode {
  const [roleResult, roleAction, rolePending] = useActionState(changeMemberRole, IDLE);
  const [removeResult, removeAction, removePending] = useActionState(removeOrgMember, IDLE);
  const [resetResult, resetAction, resetPending] = useActionState(createResetLink, IDLE_RESET);
  const [dismissedReset, setDismissedReset] = useState<string | null>(null);
  const actorOwns = actor.role === 'owner';
  const mayReset =
    (actor.role === 'owner' || actor.role === 'admin') &&
    member.userId !== actor.id && (member.role !== 'owner' || actorOwns);
  const mayEditRole = !soleOwner && (member.role !== 'owner' || actorOwns);
  const mayRemove =
    member.userId !== actor.id && !soleOwner && (member.role !== 'owner' || actorOwns);
  const result = removeResult.status !== 'idle' ? removeResult : roleResult;

  return (
    <tr data-testid="member-row" data-user-id={member.userId}>
      <td>
        {member.email ?? 'Email unavailable'}
        {member.userId === actor.id ? <Badge tone="info">you</Badge> : null}
      </td>
      <td>
        {mayEditRole ? (
          <form action={roleAction} className="wa-row">
            <input type="hidden" name="userId" value={member.userId} />
            <Select
              compact
              name="role"
              defaultValue={member.role}
              aria-label={`Role for ${member.email ?? member.userId}`}
              data-testid="member-role"
              disabled={rolePending}
              style={{ width: '8rem' }}
            >
              {ORG_ROLES.filter((role) => actorOwns || role !== 'owner').map((role) => (
                <option key={role} value={role}>{role}</option>
              ))}
            </Select>
            <Button type="submit" size="sm" disabled={rolePending}>
              Save role
            </Button>
          </form>
        ) : (
          <span data-testid="member-role-locked">
            <Badge tone={member.role === 'owner' ? 'info' : 'neutral'}>{member.role}</Badge>
            {soleOwner ? <span className="wa-hint"> final owner</span> : null}
          </span>
        )}
      </td>
      <td>{shortDate(member.createdAt)}</td>
      <td>
        {mayRemove ? (
          <form action={removeAction}>
            <input type="hidden" name="userId" value={member.userId} />
            <Button
              type="submit"
              size="sm"
              variant="danger"
              disabled={removePending}
              data-testid="remove-member"
            >
              Remove
            </Button>
          </form>
        ) : (
          <span className="wa-hint">
            {member.userId === actor.id ? 'Current session' : 'Owner protected'}
          </span>
        )}
        {result.status === 'idle' ? null : (
          <span
            className={`wa-hint${result.status === 'error' ? ' wa-text-bad' : ''}`}
            role={result.status === 'error' ? 'alert' : 'status'}
            style={{ display: 'block', marginTop: '0.25rem' }}
          >
            {result.message}
          </span>
        )}
        {mayReset ? (
          <form action={resetAction} style={{ marginTop: '0.25rem' }}>
            <input type="hidden" name="userId" value={member.userId} />
            <Button type="submit" size="sm" variant="ghost" disabled={resetPending} data-testid="create-reset-link">
              {resetPending ? 'Creating…' : 'Create reset link'}
            </Button>
          </form>
        ) : null}
        {resetResult.status === 'error' ? (
          <span className="wa-hint wa-text-bad" role="alert" data-testid="reset-link-error" style={{ display: 'block', marginTop: '0.25rem' }}>
            {resetResult.message}
          </span>
        ) : null}
        {resetResult.status === 'ok' && dismissedReset !== resetResult.url ? (
          <OnceLink
            key={resetResult.url}
            url={resetResult.url}
            urlTestId="reset-url"
            instruction={resetResult.message}
            onDone={() => setDismissedReset(resetResult.url)}
          />
        ) : null}
      </td>
    </tr>
  );
}

function InvitationRow({
  invitation,
  inviter,
}: {
  invitation: InvitationRecord;
  inviter: string;
}): ReactNode {
  const [result, action, pending] = useActionState(revokeInvite, IDLE);
  return (
    <tr data-testid="invite-row" data-invitation-id={invitation.id}>
      <td>{invitation.email}</td>
      <td><Badge>{invitation.role}</Badge></td>
      <td><code>{invitation.tokenPrefix}…</code></td>
      <td>{shortDate(invitation.expiresAt)}</td>
      <td>{inviter}</td>
      <td>
        <form action={action}>
          <input type="hidden" name="invitationId" value={invitation.id} />
          <Button
            type="submit"
            size="sm"
            variant="danger"
            disabled={pending}
            data-testid="revoke-invite"
          >
            Revoke
          </Button>
        </form>
        {result.status === 'idle' ? null : (
          <span
            className="wa-hint"
            role={result.status === 'error' ? 'alert' : 'status'}
            style={{ display: 'block', marginTop: '0.25rem' }}
          >
            {result.message}
          </span>
        )}
      </td>
    </tr>
  );
}

function shortDate(iso: string): string { return formatShellDate(iso.slice(0, 10)); }
