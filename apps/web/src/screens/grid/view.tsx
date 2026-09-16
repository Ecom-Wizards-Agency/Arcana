import { type CSSProperties } from 'react';
import { CoreReportEvidencePanel } from './core-report-evidence';

import {
  ENTITY_LABELS,
  tokens
} from '@wizard-ads/ui';

import { gateMessage } from '../../ui/gate-message';

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

function renderReady({ entity, profile, period, comparison, params, slot1: _slot1, actor, freshness: _freshness, coreEvidence }: Extract<ScreenData, { view: 'ready'; }>['props']) {
  return (<main style={main}>
    <h1 className="wa-sr-only">{ENTITY_LABELS[entity]}</h1>
    <p className="wa-sr-only">{profile.label} · {profile.countryCode} · {profile.currencyCode} · {period.start} to {period.end}</p>

    <GridWorkspace
      key={`${profile.id}:${entity}:${period.start}:${period.end}:${params.campaign ?? ''}:${params.view ?? ''}:${params.asin ?? ''}`}
      actor={actor}
      entity={entity}
      currencyCode={profile.currencyCode}
      profileId={profile.id}
      period={period}
      comparisonPeriod={comparison}
      freshnessContent={null}
      asin={params.asin ?? null}
      campaignId={entity === 'campaigns' ? params.campaign ?? null : null}
    />
    {coreEvidence?.some((item) => item.status !== 'unmeasured') ? <CoreReportEvidencePanel evidence={coreEvidence} /> : null}

  </main>);
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
  gap: 0,
  minWidth: 0,
  padding: 0,
  margin: '-1.75rem -1.75rem 0',
  width: 'calc(100% + 3.5rem)',
};

const heading: CSSProperties = { fontSize: tokens.font.size.xl, margin: '0 0 0.25rem' };

const muted: CSSProperties = { color: tokens.color.textMuted, fontSize: tokens.font.size.base, margin: 0 };
