import { ScreenSurface, EmptyState as ScreenState } from '@wizard-ads/ui';
import type { CSSProperties } from 'react';

import { gateMessage } from '../../ui/gate-message';
import { formatShellDateRange, formatTimestamp } from '../../ui/date-format';
import type { CrosscheckPanelModel } from '@wizard-ads/crosscheck-cli/pure';

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

    {data.model === null || (data.model.days.length === 0 && data.model.campaignsCompared === 0) ? (
      <ScreenState title={EMPTY_TITLE} body={EMPTY_NEXT_STEP} />
    ) : (
      <>
        <ComparisonSummary model={data.model} ranAt={data.ranAt} />
        <CrosscheckPanel model={data.model} />
      </>
    )}
  </main>);
}

const EMPTY_TITLE = 'No comparison completed yet.';
const EMPTY_NEXT_STEP = 'A comparison runs when an AdLabs export for a connected profile reaches the crosscheck inbox. Check back after the next scheduled export.';

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** What was compared, over which data dates, and when the comparison last ran. */
function ComparisonSummary({ model, ranAt }: { model: CrosscheckPanelModel; ranAt: string | null }) {
  const compared = model.days.filter((day) => day.verdict !== 'skipped_provisional').map((day) => day.date).sort();
  const provisional = model.days.length - compared.length;
  const first = compared[0], last = compared.at(-1);
  return (<section data-testid="crosscheck-summary" style={{ margin: '1rem 0 0' }}>
    <p style={summary}>
      Compared AdLabs exports against Arcana: {plural(compared.length, 'profile day')} and {plural(model.campaignsCompared, 'campaign-week')}.
    </p>
    <p style={summary}>
      Data compared: {first !== undefined && last !== undefined ? formatShellDateRange(first, last) : 'no settled day yet'}.
      {provisional > 0 ? ` ${plural(provisional, 'provisional day')} not compared yet.` : ''} Last run: {ranAt === null ? 'time unavailable' : formatTimestamp(ranAt)}.
    </p>
  </section>);
}

const main: CSSProperties = {
  fontFamily: 'var(--wa-font)',
  margin: '0 auto',
  maxWidth: '72rem',
  padding: '2rem 1.5rem',
};

const heading: CSSProperties = { fontSize: '1.5rem', margin: '0 0 0.5rem' };

const muted: CSSProperties = { color: 'var(--wa-text-muted)', fontSize: '0.875rem' };

const summary: CSSProperties = { fontSize: '0.875rem', margin: '0 0 0.25rem' };

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
