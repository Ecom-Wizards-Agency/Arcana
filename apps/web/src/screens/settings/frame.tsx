/** Settings navigation and current organization; retains the existing switch action. */
import type { ReactNode } from 'react';
import type { OrgContext } from '../../data/orgs';
import { selectOrg } from '../../ui/actions';
import { Badge, Button, Select, Tabs } from '../../ui/primitives';

const TABS = [
  { href: '/settings/account', label: 'Account' },
  { href: '/settings/profiles', label: 'Profiles' },
  { href: '/settings/connections', label: 'Connections' },
  { href: '/settings/members', label: 'Members' },
  { href: '/settings/integrations', label: 'Integrations' },
] as const;

const HREF_FOR = {
  connections: '/settings/connections',
  integrations: '/settings/integrations',
  profiles: '/settings/profiles',
  members: '/settings/members',
  account: '/settings/account',
  sync: '/sync-status',
} as const;

export function Shell({
  context,
  current,
  children,
}: {
  context: OrgContext;
  current: keyof typeof HREF_FOR;
  children: ReactNode;
}): ReactNode {
  const role = context.active?.role ?? null;
  return (
    <>
      <div
        className="wa-row"
        style={{ justifyContent: 'space-between', marginBottom: '0.75rem' }}
      >
        {current === 'sync' ? null : <Tabs items={TABS} current={HREF_FOR[current]} ariaLabel="Settings" />}

        <div className="wa-row" style={{ gap: '0.5rem' }}>
          {context.memberships.length > 1 ? (
            <form action={selectOrg} className="wa-row" style={{ gap: '0.375rem' }}>
              <Select
                compact
                name="orgId"
                aria-label="Organisation"
                defaultValue={context.active?.orgId ?? ''}
                style={{ width: 'auto' }}
              >
                {context.memberships.map((membership) => (
                  <option key={membership.orgId} value={membership.orgId}>
                    {membership.name}
                  </option>
                ))}
              </Select>
              <Button type="submit" size="sm">
                Switch
              </Button>
            </form>
          ) : (
            <Badge data-testid="org-name">{context.active?.name ?? 'no organisation'}</Badge>
          )}
          {/*
            The exact string the role matrix asserts on. It is also the honest
            phrasing: a role is a fact about this session, not a label on a
            person, and every control on the screens below is decided by it.
          */}
          <Badge tone={role === null ? 'warn' : 'info'} dot data-testid="org-role">
            {context.active ? `role: ${context.active.role}` : 'no role'}
          </Badge>
        </div>
      </div>
      {children}
    </>
  );
}
