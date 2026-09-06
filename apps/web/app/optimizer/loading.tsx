import type { CSSProperties } from 'react';
import { Card, PageHeader } from '../../src/ui/primitives';

/** Honest route feedback while campaigns and recommendation evidence load. */
export default function OptimizerLoading() {
  return (
    <main style={page} aria-busy="true" data-testid="optimizer-loading">
      <PageHeader
        title="Campaign Optimizer"
        subtitle="Loading campaigns, group settings, and recommendation evidence…"
      />
      <div className="wa-stack">
        <Card title="Campaign performance" subtitle="Preparing the selected and comparison windows…">
          <LoadingSignals labels={['Spend', 'Ad sales', 'Orders', 'ACOS']} />
        </Card>
        <Card title="Campaign workspace" subtitle="Loading every current campaign, including zero-activity rows…">
          <LoadingSignals labels={['Campaign roster', 'Optimization groups', 'Latest preview']} />
        </Card>
      </div>
    </main>
  );
}

function LoadingSignals({ labels }: { labels: readonly string[] }) {
  return (
    <div className="wa-operating-status" aria-label="Optimizer data loading">
      {labels.map((label) => (
        <div className="wa-operating-signal" key={label}>
          <span>{label}</span>
          <strong>—</strong>
        </div>
      ))}
    </div>
  );
}

/**
 * The same measure as the page it stands in for.
 *
 * It used the shared 84rem `tokens.page` column while the loaded optimizer is
 * full width, so the route flashed a narrow column and then jumped wider once
 * the campaigns arrived. Reported in slice 3, fixed here with the rest of the
 * layout work.
 */
const page: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
  minWidth: 0,
  width: '100%',
};
