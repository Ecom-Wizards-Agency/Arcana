import type { CSSProperties } from 'react';

import { SEARCH_TERM_CAP } from '../../ngrams/data';

import { NgramExplorer } from '../../../app/ngrams/explorer';

import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;

export default function ScreenView({ data }: { data: ScreenData; }) {
  switch (data.view) {
    case 'empty': return renderEmpty(data.props);
    case 'ready': return renderReady(data.props);
    case 'error': return renderError(data.props);
  }
}

function renderEmpty(_props: Extract<ScreenData, { view: 'empty'; }>['props']) {
  return (<main style={main}>
    <h1 style={heading}>N-gram explorer</h1>
    <p style={muted}>This organisation has no advertising profiles yet.</p>
  </main>);
}

function renderReady({ profile, period, payload, scopes, negativeOptions }: Extract<ScreenData, { view: 'ready'; }>['props']) {
  return (<main style={main} data-interactive="true">
    <header style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <h1 style={heading}>N-gram explorer</h1>
      <p style={muted}>
        {profile.label} · {period.start} to {period.end} · {payload.rows.length} search terms ·
        all figures in {profile.currencyCode}
      </p>
      <p style={muted}>
        A gram is counted once per search term, however many times it occurs in it. Spend is
        attributed to every gram a term contains, so gram totals overlap and do not sum to
        account spend — the search-terms column is what keeps that visible.
      </p>
    </header>

    {payload.truncated ? (
      <p style={{ ...muted, color: 'var(--wa-bad-text)' }}>
        More than {SEARCH_TERM_CAP} search terms in this period, so the set below is truncated
        and its totals cover only what is shown. Narrow the period for a complete read.
      </p>
    ) : null}

    <div className="wa-embed" style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <NgramExplorer
        rows={payload.rows}
        negativeOptions={negativeOptions}
        scopes={scopes}
        profileId={profile.id}
        currencyCode={profile.currencyCode}
        period={period}
      />
    </div>

    <p style={muted}>
      <a href={`/recommendations?profile=${profile.id}`}>Recommendations</a> ·{' '}
      <a href={`/grid?profile=${profile.id}&entity=search_terms`}>Search-term grid</a>
    </p>
  </main>);
}

function renderError({ message }: Extract<ScreenData, { view: 'error'; }>['props']) {
  return (<main style={main}>
    <h1 style={heading}>N-gram explorer</h1>
    <p role="alert">{message}</p>
  </main>);
}

/**
 * Full width, not a centred 96rem column.
 *
 * Same call as `/grid`, `/optimizer` and `/recommendations`: the explorer is a
 * grid with a drill-down grid under it, and the application frame already
 * supplies the horizontal padding. A reading measure on a table of thirteen
 * columns is the first thing the operator named when comparing these pages
 * against the grids they use elsewhere.
 */
const main: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  fontFamily: 'var(--wa-font)',
  gap: '1.5rem',
  minWidth: 0,
  width: '100%',
};

const heading: CSSProperties = { fontSize: 'var(--wa-fs-xl)', fontWeight: 640, letterSpacing: '-0.02em', margin: 0 };

const muted: CSSProperties = { color: 'var(--wa-text-muted)', fontSize: '0.875rem', margin: 0 };
