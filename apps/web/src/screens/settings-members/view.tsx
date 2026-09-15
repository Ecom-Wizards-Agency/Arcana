import { ScreenSurface, EmptyState as ScreenState } from '@wizard-ads/ui';
import { gateMessage } from '../../ui/gate-message';

import { PageHeader } from '../../ui/primitives';

import { Shell } from '../settings/frame';

import { page } from '../../ui/tokens';

import { MembersManager } from '../../../app/settings/members/manager';

import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;

function ScreenContent({ data }: { data: ScreenData; }) {
  if (data === null) return null;
  switch (data.view) {
    case 'gated': return renderGated(data.props);
    case 'forbidden': return renderForbidden(data.props);
    case 'ready': return renderReady(data.props);
  }
}

function renderGated({ entry }: Extract<ScreenData, { view: 'gated'; }>['props']) {
  return (<main style={page}>
    <PageHeader title="Members" />
    <ScreenState variant="gated" title="Access unavailable" body={<>{gateMessage(entry.state)}</>} />
  </main>);
}

function renderForbidden({ context, active }: Extract<ScreenData, { view: 'forbidden'; }>['props']) {
  return (<main style={page}>
    <Shell context={context} current="members">
      <PageHeader
        title="Members"
        subtitle="Invite people, assign access, and keep organisation ownership explicit."
      />
      <ScreenState variant="gated" title="Member management unavailable" data-testid="members-forbidden" body={<>
        Members are managed by admins and owners. Your role is <strong>{active.role}</strong>.
      </>} />
    </Shell>
  </main>);
}

function renderReady({ context, active, members, invitations }: Extract<ScreenData, { view: 'ready'; }>['props']) {
  return (<main style={page}>
    <Shell context={context} current="members">
      <PageHeader
        title="Members"
        subtitle="Invite people, assign access, and keep organisation ownership explicit."
      />
      <MembersManager
        actor={{ id: context.user.id, role: active.role }}
        members={members}
        invitations={invitations}
      />
    </Shell>
  </main>);
}

export default function ScreenView({ data }: { data: ScreenData }) {
  if (data === null) return null;
  return <ScreenSurface title="Members">{ScreenContent({ data })}</ScreenSurface>;
}
