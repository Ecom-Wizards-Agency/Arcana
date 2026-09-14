'use client';
import type { ReactNode } from 'react';
import type { FreshnessAssessment } from '@wizard-ads/ui';
import type { Tone } from './primitives';
import { useShellEvidence } from './shell-evidence';
const FRESHNESS_TONE: Record<string, Exclude<Tone, 'neutral'>> = {
  good: 'good',
  warn: 'warn',
  bad: 'bad',
  muted: 'info',
  neutral: 'info',
};

/**
 * Fresh data is routine context, not a success alert. Keep the current state
 * compact and neutral; warning and failure states still receive a tinted
 * surface because they change how every number below should be read.
 *
 * The ledger expands through `<details>`, so the disclosure needs no JavaScript
 * and this stays a server component.
 */
export function FreshnessBar({
  assessment: supplied,
  children,
}: {
  assessment?: FreshnessAssessment | undefined;
  children?: ReactNode;
}): ReactNode {
  const shell = useShellEvidence();
  const assessment = supplied ?? shell?.freshness;
  if (assessment == null) return null;
  const tone = FRESHNESS_TONE[assessment.tone] ?? 'info';
  const status = freshnessStatus(assessment.tone);
  const summary = assessment.tone === 'good' && assessment.coversThrough !== null
    ? `Through ${formatCoverageDate(assessment.coversThrough)}`
    : assessment.headline;
  return (
    <section aria-label="Data freshness" className={`wa-freshness wa-freshness--${tone}`}>
      <details>
        <summary className="wa-freshness__summary">
          <span className="wa-freshness__primary">
            <span aria-hidden="true" className="wa-freshness__dot" />
            <strong>{status}</strong>
            <span className="wa-freshness__meta">{summary}</span>
          </span>
          <span className="wa-freshness__spacer" />
          {children}
          <span className="wa-freshness__action">
            <span
              aria-label="Freshness is based on completed Amazon report loads, not fact-row timestamps."
              className="wa-info-mark"
              role="img"
              title="Freshness is based on completed Amazon report loads, not fact-row timestamps."
            >
              i
            </span>
            Sync details
          </span>
        </summary>
        <div className="wa-freshness__panel">
          <ul>
            {assessment.details.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
          <p>
            Based on the report ledger. Fact rows cannot prove freshness because Amazon may omit
            rows with no impressions.
          </p>
        </div>
      </details>
    </section>
  );
}

function freshnessStatus(tone: FreshnessAssessment['tone']): string {
  if (tone === 'good') return 'Data current';
  if (tone === 'warn') return 'Data delayed';
  if (tone === 'bad') return 'Data issue';
  return 'No data yet';
}

function formatCoverageDate(value: string): string {
  const [year, month, day] = value.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return value;
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
    year: 'numeric',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

