import { formatResearchPeriod } from './research-format';
import { QueryResearch } from './research-view';
import { AbaEvidencePanel } from '../grid/spapi-evidence';
import { ProviderEvidencePanel } from '../recommendations/provider-evidence';
import type { CSSProperties } from 'react';
import { CoreReportEvidencePanel } from '../grid/core-report-evidence';

import {
  type ContextualNegativeReviewLoad
} from '@wizard-ads/db';

import {
  QUERY_CATEGORY_OPTIONS,
  QueryIntelligenceWorkspace,
} from '../../../app/query-intelligence/workspace';

import {
  NegativeProposalReview,
  type ContextualNegativeReviewState,
} from '../../../app/query-intelligence/negative-review';

import styles from '../../../app/query-intelligence/query-intelligence.module.css';

import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;

/** The page title; the descriptor's guard heading repeats it so the signed-in guard finds the same heading. */
export const SQP_TITLE = 'Search query performance (SQP)';
/** One line under the title: what the data is and where it comes from. */
export const SQP_EXPLANATION = 'Amazon Brand Analytics search query performance, reported weekly for each marketplace. It arrives through the Seller Central connection.';

function SqpTitle({ sub }: { sub: string }) {
  return (<div>
    <h1 className="wa-page-title">{SQP_TITLE}</h1>
    <p className="wa-page-sub" data-testid="sqp-explanation">{SQP_EXPLANATION}</p>
    <p className="wa-page-sub">{sub}</p>
  </div>);
}

export default function ScreenView({ data }: { data: ScreenData; }) {
  switch (data.view) {
    case 'empty': return renderEmpty(data.props);
    case 'not-measured': return renderNotMeasured(data.props);
    case 'ready': return renderReady(data.props);
    case 'error': return renderError(data.props);
  }
}

function renderEmpty(_props: Extract<ScreenData, { view: 'empty'; }>['props']) {
  return (<main className="wa-stack">
    <header className="wa-page-head">
      <SqpTitle sub="This organisation has no advertising profiles yet." />
    </header>
  </main>);
}

function renderNotMeasured({ providerEvidence, profile, coreEvidence, aba, research }: Extract<ScreenData, { view: 'not-measured'; }>['props']) {
  return (<main className="wa-stack">
    <header className="wa-page-head">
      <SqpTitle sub={profile.label} />
    </header>
    <div className="wa-empty" data-state="not-measured">
      <p className="wa-empty__title">No weekly SQP data yet</p>
      <p className="wa-empty__body">
        Next step: connect Seller Central in Settings → Connections. Once it is connected, Amazon's weekly search query performance report arrives on its own, and this page fills in once the first full week (Sunday to Saturday) is in.
      </p>
      <a className="wa-btn wa-btn--sm" href="/settings/connections">Connect Seller Central</a>
      <p className="wa-empty__meta">No report was requested and no Amazon change was made.</p>
    </div>
    <ProviderEvidencePanel evidence={providerEvidence} consumer="query-intelligence" />
    {coreEvidence ? <CoreReportEvidencePanel evidence={coreEvidence} title="Sponsored Brands paid queries" /> : null}
    {research ? <>
      <AbaEvidencePanel evidence={aba} />
      <QueryResearch key={`${profile.id}:${research.weekStart}:${research.category}:${research.search}`} initialCategory={research.category} initialSearch={research.search} profileId={profile.id} marketplaceId={research.marketplaceId} facts={research.model.queryRows} ppc={research.model.ppcRows} vocabulary={research.model.vocabulary}/>
    </> : null}
  </main>);
}

function renderReady({ providerEvidence, aba, profile, scope, scopes, category, search, model, contextualReview, contextualExports, role, coreEvidence }: Extract<ScreenData, { view: 'ready'; }>['props']) {
  return (<main className="wa-stack" data-interactive="true">
    <ProviderEvidencePanel evidence={providerEvidence} consumer="query-intelligence" />
    {coreEvidence ? <CoreReportEvidencePanel evidence={coreEvidence} title="Sponsored Brands paid queries" /> : null}
    <header className="wa-page-head">
      <SqpTitle sub={`${profile.label} · ${scope.marketplaceId} · ${formatResearchPeriod({ start: scope.weekStart, end: scope.weekEnd })}`} />
      <span className="wa-badge wa-badge--info">Review and evidence only · Amazon not updated</span>
    </header>

    <form className="wa-toolbar" method="get" aria-label="Query intelligence filters">
      <input type="hidden" name="profile" value={profile.id} />
      <label className="wa-field" style={filterControl}>
        <span className="wa-label">Marketplace and week</span>
        <select
          className="wa-select wa-select--sm"
          name="scope"
          defaultValue={`${scope.marketplaceId}|${scope.weekStart}`}
        >
          {scopes.map((option) => (
            <option
              key={`${option.marketplaceId}:${option.weekStart}`}
              value={`${option.marketplaceId}|${option.weekStart}`}
            >
              {option.marketplaceId} · {formatResearchPeriod({ start: option.weekStart, end: option.weekEnd })}
            </option>
          ))}
        </select>
      </label>
      <label className="wa-field" style={filterControl}>
        <span className="wa-label">Intent</span>
        <select className="wa-select wa-select--sm" name="category" defaultValue={category ?? ''}>
          <option value="">All six categories</option>
          {QUERY_CATEGORY_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </label>
      <label className="wa-field" style={{ ...filterControl, flex: '1 1 16rem' }}>
        <span className="wa-label">Find query, ASIN, campaign, or ad group</span>
        <input className="wa-input wa-input--sm" type="search" name="q" defaultValue={search} />
      </label>
      <button className="wa-btn wa-btn--sm" type="submit">Apply</button>
      {category !== null || search.length > 0 ? (
        <a
          className="wa-btn wa-btn--ghost wa-btn--sm"
          href={`/queries?${new URLSearchParams({
            profile: profile.id,
            scope: `${scope.marketplaceId}|${scope.weekStart}`,
          })}`}
        >
          Clear
        </a>
      ) : null}
      <span className={styles.toolbarMeta}>
        {model.queryRows.length ? `${scope.factRows} query/ASIN rows · loaded ${new Intl.DateTimeFormat('en-US', {dateStyle:'medium',timeZone:'UTC'}).format(new Date(scope.loadedAt))}` : 'No authoritative weekly SQP data'}
      </span>
    </form>

    <AbaEvidencePanel evidence={aba} />
    <QueryResearch key={`${profile.id}:${scope.weekStart}:${category}:${search}`} initialCategory={category} initialSearch={search} profileId={profile.id} marketplaceId={scope.marketplaceId} facts={model.queryRows} ppc={model.ppcRows} vocabulary={model.vocabulary}/>
    {model.queryRows.length ? <details><summary>Attribution and contextual negative review</summary>
    <QueryIntelligenceWorkspace
      model={model}
      currencyCode={profile.currencyCode}
      selectedCategory={category}
      search={search}
      negativeReview={(
        <NegativeProposalReview
          key={`${profile.id}:${scope.marketplaceId}`}
          review={reviewState(contextualReview)}
          exports={contextualExports.map((record) => ({
            id: record.id,
            rowCount: record.rowCount,
            createdAt: record.createdAt.toISOString(),
            note: record.note,
          }))}
          profileId={profile.id}
          marketplaceId={scope.marketplaceId}
          role={role}
        />
      )}
    />
    </details> : null}
  </main>);
}

function renderError({ message }: Extract<ScreenData, { view: 'error'; }>['props']) {
  return (<main className="wa-stack">
    <header className="wa-page-head">
      <SqpTitle sub="Weekly SQP and PPC evidence could not be loaded." />
    </header>
    <p className="wa-banner wa-banner--bad" role="alert">{message}</p>
  </main>);
}

function reviewState(review: ContextualNegativeReviewLoad): ContextualNegativeReviewState {
  if (review.status === 'capacity_exceeded') {
    const reasons = {
      row_limit: 'The review scope exceeds its row limit.',
      byte_limit: 'The review fields exceed their byte limit.',
      timeout: 'The complete review snapshot exceeded its five-second query budget.',
    } as const;
    return {
      status: 'capacity_exceeded',
      rowCount: review.rowCount,
      reviewBytes: review.reviewBytes,
      rowLimit: review.limits.rows,
      byteLimit: review.limits.reviewBytes,
      measurementsAvailable: review.measurementsAvailable,
      reason: reasons[review.reason],
    };
  }
  return {
    status: 'ready',
    proposals: review.proposals.map((proposal) => ({
      id: proposal.id,
      profileId: proposal.profileId,
      marketplaceId: proposal.marketplaceId,
      campaignId: proposal.campaignId,
      adGroupId: proposal.adGroupId,
      searchTerm: proposal.searchTerm,
      normalizedQuery: proposal.normalizedQuery,
      category: proposal.category,
      sourceGroupRole: proposal.sourceGroupRole,
      matchType: proposal.matchType,
      reason: proposal.reason,
      status: proposal.status,
      reviewFingerprint: proposal.reviewFingerprint,
    })),
    counts: {
      proposed: review.statusCounts.proposed,
      accepted: review.statusCounts.accepted,
      dismissed: review.statusCounts.dismissed,
      exported: review.statusCounts.exported,
    },
    rowCount: review.rowCount,
    reviewBytes: review.reviewBytes,
  };
}

const filterControl: CSSProperties = { minWidth: '10rem' };
