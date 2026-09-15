import { ScreenSurface, EmptyState as ScreenState } from '@wizard-ads/ui';
import { gateMessage } from '../../ui/gate-message';

import { PageHeader } from '../../ui/primitives';

import { page } from '../../ui/tokens';

import { ConnectClaudeManager } from '../../../app/connect-claude/manager';

import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;

function ScreenContent({ data }: { data: ScreenData; }) {
  if (data === null) return null;
  switch (data.view) {
    case 'gated': return renderGated(data.props);
    case 'ready': return renderReady(data.props);
  }
}

function renderGated({ entry }: Extract<ScreenData, { view: 'gated'; }>['props']) {
  return (<main style={page}>
    <PageHeader title="Connect AI (MCP)" />
    <ScreenState variant="gated" title="Access unavailable" body={gateMessage(entry.state)} />
  </main>);
}

function renderReady({ endpoint, keys, profiles, canManage, org }: Extract<ScreenData, { view: 'ready'; }>['props']) {
  return (<main style={page}>
    <PageHeader
      title="Connect AI (MCP)"
      subtitle="Give any MCP client a read-only key to your advertising data over the Model Context Protocol."
    />

    <div className="wa-support-stack">
      {endpoint !== null ? <section className="wa-support-panel">
        <header className="wa-support-panel-head">
          <h2 className="wa-support-panel-title">How it connects</h2>
        </header>
        <div className="wa-support-panel-body">
          <ol style={{ margin: 0, paddingLeft: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
            <li>Issue a key below and copy it — it is shown once and never stored in full.</li>
            <li>
              Point your client at your MCP endpoint: <code>{endpoint}</code>
            </li>
            <li>
              Store the key in <code>WIZARD_ADS_MCP_TOKEN</code>. The client can then read only
              the profiles selected when the key was issued.
            </li>
          </ol>
          <p className="wa-support-note" style={{ marginTop: '0.75rem' }}>
            One key, any MCP client — Claude, Codex, ChatGPT, Cursor or Gemini all connect over the
            same endpoint and bearer token. The setup snippets below reference the environment
            variable by name and never contain its value.
          </p>
          <p className="wa-support-note" style={{ marginTop: '0.5rem' }}>
            Every new key is read-only, expires automatically, and has a hard profile allowlist.
            Arcana currently exposes no Amazon write tools through MCP.
          </p>
        </div>
      </section> : null}

      <ConnectClaudeManager
        keys={keys}
        profiles={profiles.map((profile) => ({ id: profile.id, label: profile.label }))}
        canManage={canManage}
        role={org.role}
        endpoint={endpoint}
      />
    </div>
  </main>);
}

export default function ScreenView({ data }: { data: ScreenData }) {
  if (data === null) return null;
  return <ScreenSurface title="Connect AI (MCP)">{ScreenContent({ data })}</ScreenSurface>;
}
