// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { OrgRole } from '../../auth/roles';
import type { MemberRecord } from '../../data/members';
import { context, org } from '../synthetic-render-fixtures';

const actions = vi.hoisted(() => ({
  createInvite: vi.fn(), sendInviteEmail: vi.fn(), createResetLink: vi.fn(),
  changeMemberRole: vi.fn(), removeOrgMember: vi.fn(), revokeInvite: vi.fn(),
}));
vi.mock('../../../app/settings/members/actions', () => actions);
import { MembersManager } from '../../../app/settings/members/manager';
import Screen from './view';

const member = (userId: string, role: OrgRole): MemberRecord => ({
  userId, email: `${userId}@example.test`, role, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
});
const members = [member('self', 'owner'), member('other-owner', 'owner'), member('admin', 'admin'), member('viewer', 'viewer')];
const inviteUrl = 'https://app.example.test/invite/synthetic-token?token_hash=synthetic-hash';

afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('members screen one-time links', () => {
  it('shows the new link once with its status, note and the secondary email button', async () => {
    actions.createInvite.mockResolvedValue({
      status: 'ok', inviteUrl, token: 'synthetic-token', delivery: 'link_ready', deliveryLabel: 'Link ready',
      message: 'Send this link to person@example.test yourself; it opens the invitation and lets them set a password. It is shown only now.',
      invitation: { email: 'person@example.test' },
    });
    actions.sendInviteEmail.mockResolvedValue({
      status: 'ok', delivery: 'unavailable', label: 'Email not sent',
      message: 'Email invitations are not configured. Existing users can accept the link; an installation operator must arrange activation for new users.',
    });
    render(<MembersManager actor={{ id: 'self', role: 'owner' }} members={members} invitations={[]} />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'person@example.test' } });
    fireEvent.click(screen.getByTestId('create-invite'));

    await waitFor(() => expect(screen.getAllByTestId('invite-url')).toHaveLength(1));
    expect(screen.getByTestId('invite-url').textContent).toBe(inviteUrl);
    expect(screen.getByTestId('invite-delivery-status').textContent).toBe('Link ready');
    expect(screen.getByTestId('invite-url-instruction').textContent).toBe(
      'Send this link to person@example.test yourself; it opens the invitation and lets them set a password. It is shown only now.',
    );
    expect(screen.getByText('Sending the email replaces the link above; they must then use the email.')).toBeDefined();
    expect(screen.getAllByRole('button', { name: 'Also send by email' })).toHaveLength(1);

    fireEvent.click(screen.getByTestId('invite-send-email'));
    await waitFor(() => expect(screen.getAllByTestId('invite-email-status')).toHaveLength(1));
    expect(actions.sendInviteEmail).toHaveBeenCalledTimes(1);
    expect((actions.sendInviteEmail.mock.calls[0]![1] as FormData).get('token')).toBe('synthetic-token');
    expect(screen.getByTestId('invite-email-status').textContent).toBe(
      'Email not sent. Email invitations are not configured. Existing users can accept the link; an installation operator must arrange activation for new users.',
    );
    expect(screen.getByTestId('invite-email-status').getAttribute('role')).toBe('alert');

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryAllByTestId('invite-url')).toHaveLength(0);
  });

  it('warns that an uncertain email may have replaced the shown new-account link', async () => {
    actions.createInvite.mockResolvedValue({
      status: 'ok', inviteUrl, token: 'synthetic-token', delivery: 'link_ready', deliveryLabel: 'Link ready',
      message: 'Send this link to person@example.test yourself; it opens the invitation and lets them set a password. It is shown only now.',
      invitation: { email: 'person@example.test' },
    });
    actions.sendInviteEmail.mockResolvedValue({
      status: 'ok', delivery: 'uncertain', label: 'Email not sent',
      message: 'The invitation is saved, but email delivery could not be confirmed. Check for the email before requesting another invitation.',
    });
    render(<MembersManager actor={{ id: 'self', role: 'owner' }} members={members} invitations={[]} />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'person@example.test' } });
    fireEvent.click(screen.getByTestId('create-invite'));
    await waitFor(() => expect(screen.getAllByTestId('invite-send-email')).toHaveLength(1));
    fireEvent.click(screen.getByTestId('invite-send-email'));
    await waitFor(() => expect(screen.getAllByTestId('invite-email-status')).toHaveLength(1));
    expect(screen.getByTestId('invite-email-status').textContent).toBe(
      'Email not sent. The invitation is saved, but email delivery could not be confirmed. Check for the email before requesting another invitation. The link above may no longer work; revoke this invitation and invite again.',
    );
  });

  it('offers reset links to an owner for every other member, including another owner', () => {
    render(<MembersManager actor={{ id: 'self', role: 'owner' }} members={members} invitations={[]} />);
    const rows = screen.getAllByTestId('member-row');
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.querySelectorAll('[data-testid="create-reset-link"]').length)).toEqual([0, 1, 1, 1]);
  });

  it('offers an admin reset links for non-owners only', () => {
    render(<MembersManager actor={{ id: 'admin', role: 'admin' }} members={members} invitations={[]} />);
    const rows = screen.getAllByTestId('member-row');
    expect(rows.map((row) => row.querySelectorAll('[data-testid="create-reset-link"]').length)).toEqual([0, 0, 0, 1]);
  });

  it.each(['analyst', 'viewer'] as const)('never offers %s a reset control', (role) => {
    render(<MembersManager actor={{ id: 'viewer', role }} members={members} invitations={[]} />);
    expect(screen.queryAllByTestId('create-reset-link')).toHaveLength(0);
    cleanup();
    render(<Screen data={{ view: 'forbidden', props: { context, active: { ...org, role } } }} />);
    expect(screen.getAllByTestId('members-forbidden')).toHaveLength(1);
    expect(screen.queryAllByTestId('create-reset-link')).toHaveLength(0);
    expect(screen.queryAllByTestId('create-invite')).toHaveLength(0);
  });

  it('shows a reset link once and a refusal as an alert', async () => {
    actions.createResetLink
      .mockResolvedValueOnce({
        status: 'ok', url: 'https://app.example.test/auth/recovery/callback?next=%2Fdashboard&token_hash=synthetic',
        message: 'Send this link to viewer@example.test yourself; it lets them choose a new password. It is shown only now.',
      })
      .mockResolvedValueOnce({ status: 'error', message: 'A reset link was created for this member in the last 10 minutes. Try again later.' });
    render(<MembersManager actor={{ id: 'admin', role: 'admin' }} members={members} invitations={[]} />);
    fireEvent.click(screen.getByTestId('create-reset-link'));
    await waitFor(() => expect(screen.getAllByTestId('reset-url')).toHaveLength(1));
    expect((actions.createResetLink.mock.calls[0]![1] as FormData).get('userId')).toBe('viewer');
    expect(screen.getByTestId('reset-url-instruction').textContent).toBe(
      'Send this link to viewer@example.test yourself; it lets them choose a new password. It is shown only now.',
    );
    fireEvent.click(screen.getByTestId('create-reset-link'));
    await waitFor(() => expect(screen.getAllByTestId('reset-link-error')).toHaveLength(1));
    expect(screen.getByTestId('reset-link-error').textContent).toBe('A reset link was created for this member in the last 10 minutes. Try again later.');
    expect(screen.queryAllByTestId('reset-url')).toHaveLength(0);
  });
});
