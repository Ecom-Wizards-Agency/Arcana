import { gateMessage } from '../../ui/gate-message';

import { Banner, PageHeader } from '../../ui/primitives';

import { Shell } from '../../ui/shell';

import { page } from '../../ui/tokens';

import { PasswordForm } from '../../../app/settings/account/password-form';

import { PasskeyManager } from '../../../app/settings/account/passkey-manager';

import { TotpManager } from '../../../app/settings/account/totp-manager';

import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;

export default function ScreenView({ data }: { data: ScreenData; }) {
  if (data === null) return null;
  switch (data.view) {
    case 'gated': return renderGated(data.props);
    case 'ready': return renderReady(data.props);
  }
}

function renderGated({ entry }: Extract<ScreenData, { view: 'gated'; }>['props']) {
  return (<main style={page}>
    <PageHeader title="Account" />
    <Banner tone="warn">{gateMessage(entry.state)}</Banner>
  </main>);
}

function renderReady({ context, totp, next, config }: Extract<ScreenData, { view: 'ready'; }>['props']) {
  return (<main style={page}>
    <Shell context={context} current="account">
      <PageHeader
        title="Account"
        subtitle="Add a password to your existing account or replace the one you use now."
      />
      <PasswordForm />
      <TotpManager overview={totp} next={next} allowEnrollment={config.totpPolicy !== 'off'} />
      {config.passkeyPolicy === 'off' ? null : (
        <PasskeyManager policy={config.passkeyPolicy} />
      )}
    </Shell>
  </main>);
}
