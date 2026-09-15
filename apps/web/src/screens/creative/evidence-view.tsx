import type { readCreativePerformance } from '@wizard-ads/db';
import { CreativePerformanceExplorer } from './attribution-evidence';
import styles from '../../../app/creative/creative.module.css';
import { creativeLifecycle, type CreativeLifecycleEvidence } from '../../creative/lifecycle';
import { EmptyState } from '../../ui/primitives';

type CreativeRows = Awaited<ReturnType<typeof readCreativePerformance>>;

export function CreativeLifecycleStatusView({
  evidence,
  timezone,
  profileId,
}: {
  evidence: CreativeLifecycleEvidence;
  timezone: string;
  profileId: string;
}) {
  const lifecycle = creativeLifecycle(evidence);
  return (
    <section
      aria-label="Creative synchronization evidence"
      className={styles.lifecycle}
      data-state={lifecycle.state}
      data-testid="creative-lifecycle"
    >
      <div className={styles.lifecycleCopy}>
        <span className={styles.lifecycleEyebrow}>
          <span aria-hidden="true" className={styles.lifecycleDot} />
          {lifecycle.eyebrow}
        </span>
        <strong>{lifecycle.title}</strong>
        <p>{lifecycle.body}</p>
      </div>
      {lifecycle.counts.length === 0 ? null : (
        <dl className={styles.lifecycleCounts}>
          {lifecycle.counts.map((count) => (
            <div key={count.label}>
              <dt>{count.label}</dt>
              <dd>{count.value.toLocaleString('en-US')}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className={styles.lifecycleMeta}>
        {lifecycle.observedAt === null ? null : (
          <span>
            Observed{' '}
            <time dateTime={lifecycle.observedAt}>{formatObserved(lifecycle.observedAt, timezone)}</time>
          </span>
        )}
        {lifecycle.coverage === null ? null : <span>Evidence date {lifecycle.coverage}</span>}
        <a href={`/sync-status?profile=${profileId}`}>Sync status →</a>
      </div>
    </section>
  );
}

export function CreativeResultsView({
  rows,
  evidence,
  currencyCode,
  profileId,
}: {
  rows: CreativeRows;
  evidence: CreativeLifecycleEvidence;
  currencyCode: string;
  profileId: string;
}) {
  const resolved = rows;
  const lifecycle = creativeLifecycle(evidence);
  const hasPerformanceOutsideWindow = lifecycle.state === 'performance_ready';
  return resolved.length === 0 ? (
    <div className={styles.emptyWrap}>
      <EmptyState
        title={hasPerformanceOutsideWindow ? 'No creative performance in this date range' : lifecycle.title}
        body={
          hasPerformanceOutsideWindow
            ? 'The latest sync promoted attributable facts, but none fall inside the selected reporting window.'
            : lifecycle.body
        }
        meta="Creative names and ad-group totals are never substituted for an observed ad → creative → Amazon Asset ID mapping."
        action={
          <a className="wa-btn wa-btn--sm" href={`/sync-status?profile=${profileId}`}>
            Check Sync status
          </a>
        }
        data-testid="creative-source-empty"
      />
    </div>
  ) : (
    <CreativePerformanceExplorer rows={resolved} currencyCode={currencyCode} />
  );
}

function formatObserved(value: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone,
  }).format(new Date(value));
}
