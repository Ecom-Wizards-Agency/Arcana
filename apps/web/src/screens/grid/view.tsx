import { Suspense, type CSSProperties } from 'react';

import {
  ENTITY_LABELS,
  tokens
} from '@wizard-ads/ui';

import { gateMessage } from '../../ui/gate-message';

import {
  todayIso
} from '../../../app/_lib/periods';

import { GridOperatorContext } from '../../../app/grid/grid-context';

import { GridWorkspace } from '../../../app/grid/grid-client';

import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;

export default function ScreenView({ data }: { data: ScreenData; }) {
  switch (data.view) {
    case 'gated': return renderGated(data.props);
    case 'no-database': return renderNoDatabase(data.props);
    case 'empty': return renderEmpty(data.props);
    case 'ready': return renderReady(data.props);
  }
}

function renderGated({ entry }: Extract<ScreenData, { view: 'gated'; }>['props']) {
  return (<main style={main}>
    <h1 style={heading}>Grid</h1>
    <p style={muted}>{gateMessage(entry.state)}</p>
  </main>);
}

function renderNoDatabase(_props: Extract<ScreenData, { view: 'no-database'; }>['props']) {
  return (<main style={main}>
    <h1 style={heading}>Grid</h1>
    <p style={muted}>{gateMessage('no-database')}</p>
  </main>);
}

function renderEmpty({ data }: Extract<ScreenData, { view: 'empty'; }>['props']) {
  return (<main style={main}>
    <h1 style={heading}>Grid</h1>
    <p className="wa-page-sub">
      {data.profiles.length === 0
        ? 'No advertising profiles yet. Connect an account and enable sync on a profile to see one here.'
        : 'Choose an advertising profile from the switcher in the top bar to load the grid.'}
    </p>
  </main>);
}

function renderReady({ entity, profile, period, comparison, params, slot1, actor, freshness }: Extract<ScreenData, { view: 'ready'; }>['props']) {
  return (<main style={main}>
    <header style={{ display: 'flex', flexDirection: 'column', gap: tokens.space(3) }}>
      <div>
        <h1 className="wa-page-title">{ENTITY_LABELS[entity]}</h1>
        <p className="wa-page-sub">
          {profile.label} · {period.start} to {period.end} · compared against {comparison.start} to{' '}
          {comparison.end} · all figures in {profile.currencyCode}
        </p>
      </div>

    </header>

    <GridOperatorContext
      account={profile.label}
      marketplace={profile.countryCode}
      currencyCode={profile.currencyCode}
      timezone={profile.timezone}
      path="/grid"
      period={period}
      today={todayIso()}
      preserved={{
        profile: profile.id,
        entity,
        ...(params.view === undefined ? {} : { view: params.view }),
        ...(params.campaign === undefined ? {} : { campaign: params.campaign }),
      }}
    />

    <Suspense fallback={<CockpitPending />}>
      {slot1}
    </Suspense>

    <GridWorkspace
      key={`${profile.id}:${entity}:${period.start}:${period.end}:${params.campaign ?? ''}:${params.view ?? ''}`}
      actor={actor}
      entity={entity}
      currencyCode={profile.currencyCode}
      profileId={profile.id}
      period={period}
      comparisonPeriod={comparison}
      freshnessContent={
        <Suspense fallback={<span aria-busy="true" style={crosscheckPending}>Freshness and crosscheck loading…</span>}>
          {freshness}
        </Suspense>
      }
      campaignId={entity === 'campaigns' ? params.campaign ?? null : null}
    />

    <p style={muted}>
      {/* The accent token rather than a hex literal: an inline colour does not
            follow the theme, and the literal this replaced rendered at 2.98:1
            against the dark background. */}
      <a href={`/?profile=${profile.id}`} style={{ color: 'var(--wa-accent)' }}>
        ← Back to the dashboard
      </a>
    </p>
  </main>);
}

function CockpitPending() {
  return (
    <p aria-busy="true" data-testid="grid-cockpit-pending" style={crosscheckPending}>
      Loading the performance tiles and trend…
    </p>
  );
}

/**
 * Full width, not a centred column. The operator compared this page against
 * AdLabs and the narrow reading column was the first thing named: a grid with
 * twenty visible columns wants every pixel the frame gives it.
 */
const main: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  fontFamily: tokens.font.sans,
  gap: tokens.space(4),
  minWidth: 0,
  padding: '1.5rem 0 2rem',
  width: '100%',
};

const heading: CSSProperties = { fontSize: tokens.font.size.xl, margin: '0 0 0.25rem' };

const muted: CSSProperties = { color: tokens.color.textMuted, fontSize: tokens.font.size.base, margin: 0 };

const crosscheckPending: CSSProperties = {
  color: tokens.color.textMuted,
  fontSize: tokens.font.size.sm,
};
