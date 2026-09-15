import { ScreenSurface, EmptyState as ScreenState } from '@wizard-ads/ui';
import type { CSSProperties } from 'react';

import { gateMessage } from '../../ui/gate-message';

import { CrosscheckPanel } from '../../../app/crosscheck/panel';

import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;

function ScreenContent({ data }: { data: ScreenData; }) {
  switch (data.view) {
    case 'gated': return renderGated(data.props);
    case 'no-database': return renderNoDatabase(data.props);
    case 'ready': return renderReady(data.props);
  }
}

function renderGated({ entry }: Extract<ScreenData, { view: 'gated'; }>['props']) {
  return (<main style={main}>
    <h1 style={heading}>Crosscheck</h1>
    <ScreenState variant="gated" title="Access unavailable" body={gateMessage(entry.state)} />
  </main>);
}

function renderNoDatabase(_props: Extract<ScreenData, { view: 'no-database'; }>['props']) {
  return (<main style={main}>
    <h1 style={heading}>Crosscheck</h1>
    <ScreenState variant="gated" title="Access unavailable" body={gateMessage('no-database')} />
  </main>);
}

function renderReady({ data }: Extract<ScreenData, { view: 'ready'; }>['props']) {
  return (<main style={main}>
    <h1 style={heading}>Crosscheck</h1>
    <p style={muted}>
      Our synced facts against the incumbent&apos;s export, per day and per campaign-week. The
      in-progress day is excluded and shown: sales restate for 14 days, so judging it would
      raise a false alarm every morning.
    </p>

    {data.profiles.length > 1 ? (
      <nav style={nav}>
        {data.profiles.map((option) => (
          <a
            key={option.profileId}
            href={`/crosscheck?profile=${option.profileId}`}
            style={{
              ...tab,
              fontWeight: option.profileId === data.selected ? 600 : 400,
            }}
          >
            {option.label} <span style={muted}>{option.region}</span>
          </a>
        ))}
      </nav>
    ) : null}

    {data.model === null ? (
      <ScreenState title="Nothing has been cross-checked yet." body="Choose a connected profile or check again after the next sync." />
    ) : (
      <CrosscheckPanel model={data.model} />
    )}
  </main>);
}

const main: CSSProperties = {
  fontFamily: 'var(--wa-font)',
  margin: '0 auto',
  maxWidth: '72rem',
  padding: '2rem 1.5rem',
};

const heading: CSSProperties = { fontSize: '1.5rem', margin: '0 0 0.5rem' };

const muted: CSSProperties = { color: 'var(--wa-text-muted)', fontSize: '0.875rem' };

const nav: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: '0.75rem', margin: '1rem 0' };

const tab: CSSProperties = {
  border: '1px solid var(--wa-border)',
  borderRadius: '0.375rem',
  color: 'inherit',
  padding: '0.25rem 0.625rem',
  textDecoration: 'none',
};

export default function ScreenView({ data }: { data: ScreenData }) {
  return <ScreenSurface title="Crosscheck">{ScreenContent({ data })}</ScreenSurface>;
}
