import React from 'react';
import type { ReactNode } from 'react';
import Loading from '../../src/screens/shared-loading';
import SharedError from '../../src/screens/shared-error';
import { VocabularyEditor } from '../../src/screens/query-intelligence/vocabulary';
import { QueryResearch } from '../../src/screens/query-intelligence/research-view';
import { researchFacts } from '../../src/screens/query-intelligence/research-fixture';
import QueryScreen from '../../src/screens/query-intelligence/view';
import { NgramExplorer } from '../../app/ngrams/explorer';
import { NgramNegativeReviewPanel } from '../../src/screens/ngrams/negative-review';
import NgramScreen from '../../src/screens/ngrams/view';
import { buildNgramNegativeReview } from '@wizard-ads/core';
import DaypartingScreen, { HourlyMeasurement } from '../../src/screens/dayparting/view';
import { DaypartingWorkspaceView, DaypartingResultsView, ScheduleExecutionStatus } from '../../src/screens/dayparting/workspace';
import { daypartingFixture, measuredDaypartingFixture, dayEvidence, syntheticSchedule, ready as emptyDayparting } from '../../src/screens/dayparting/render-fixture';
import BrandScreen, { BrandLens } from '../../src/screens/brand-lens/view';
import { brandReady } from '../../src/screens/brand-lens/render-fixture';
const termRows = [{
  searchTerm: 'synthetic component one',
  campaignId: 'synthetic-campaign',
  adGroupId: 'synthetic-ad-group',
  impressions: 170,
  clicks: 17,
  cost: 37,
  purchases7d: 0,
  sales7d: 0
}, {
  searchTerm: 'synthetic component two',
  campaignId: 'synthetic-campaign-two',
  adGroupId: 'synthetic-ad-group-two',
  impressions: 190,
  clicks: 19,
  cost: 43,
  purchases7d: 0,
  sales7d: 0
}];
export type ResearchScreen = 'queries' | 'ngrams' | 'dayparting' | 'brand-lens';
export function researchVisuals(screen: ResearchScreen): Record<string, ReactNode> {
  const vocabulary = {id:'11111111-1111-4111-8111-111111111111',orgId:'11111111-1111-4111-8111-111111111111',marketplaceId:'synthetic-market',kind:'own_brand_term' as const,value:'Synthetic token',normalizedValue:'synthetic token',source:'operator' as const,approved:false,reviewedAt:null};
  const common = {
    loading: <Loading />,
    error: <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-reference' })} reset={() => { }} />
  };
  if (screen === 'queries') return {
    'vocabulary-pending':<VocabularyEditor profileId={vocabulary.orgId} entries={[vocabulary]}/>,
    'vocabulary-approved':<VocabularyEditor profileId={vocabulary.orgId} entries={[{...vocabulary,approved:true,reviewedAt:'2026-06-15T12:00:00Z'}]}/>,
    'impression-share':<QueryResearch profileId="synthetic" marketplaceId="synthetic-market" facts={researchFacts} ppc={[]} vocabulary={[]} initialMetric="impressions"/>,
    ...common,
    empty: <QueryScreen data={{
      view: 'empty',
      props: {}
    }} />,
    measured: <QueryResearch profileId="synthetic" marketplaceId="synthetic-market" facts={researchFacts} ppc={[]} vocabulary={[]} />,
    'not-measured': <QueryResearch profileId="synthetic" marketplaceId="synthetic-market" facts={[]} ppc={[{ searchTerm: 'Synthetic component' }]} vocabulary={[]} />
  };
  if (screen === 'ngrams') {
    const negative = buildNgramNegativeReview(termRows, 'synthetic component', 2, {
      targetAcos: 0.37,
      aov: 29
    })!, converting = buildNgramNegativeReview(termRows.map(r => ({
      ...r,
      purchases7d: 1,
      sales7d: 17
    })), 'synthetic component', 2, {
      targetAcos: 0.37,
      aov: 29
    })!;
    const reviewProps = {
      profileId: 'synthetic',
      period: {
        start: '2026-06-01',
        end: '2026-06-07'
      },
      currencyCode: 'USD',
      campaignNames: {},
      onDismiss: () => { }
    };
    return {
      ...common,
      empty: <NgramScreen data={{
        view: 'empty',
        props: {}
      }} />,
      ...Object.fromEntries(([1, 2, 3] as const).map(size => [`gram-${size}`, <NgramExplorer rows={termRows} scopes={{
        campaigns: [],
        tags: []
      }} profileId="synthetic" currencyCode="USD" period={reviewProps.period} initialSize={size} initialGridRect={{
        width: 1120,
        height: 400
      }} />])),
      'review-no-sales': <NgramNegativeReviewPanel {...reviewProps} review={negative} />,
      'calculation-acos':<NgramNegativeReviewPanel {...reviewProps} review={converting} initialCalculationOpen/>,
      'review-acos': <NgramNegativeReviewPanel {...reviewProps} review={converting} />,
      calculation: <NgramNegativeReviewPanel {...reviewProps} review={negative} initialCalculationOpen />,
      queued: <NgramNegativeReviewPanel {...reviewProps} review={negative} initialQueued />
    };
  }
  if (screen === 'dayparting') {
    const data = daypartingFixture(), measurement = <HourlyMeasurement {...data} />;
    const suggestion = {
      id: syntheticSchedule().id,
      profileId: data.profile.id,
      campaignId: 'synthetic-campaign',
      baselineLabel: 'Synthetic alternative',
      evidenceStart: '2026-06-01',
      evidenceEnd: '2026-06-07',
      settledHours: 168,
      blocks: [{
        dayOfWeek: 1,
        startHour: 17,
        endHour: 21,
        adjustmentPercent: 37,
        confidence: 0.8
      }],
      status: 'proposed' as const
    };
    const result = {
      before: {
        start: '2026-06-01',
        end: '2026-06-07',
        spend: 137,
        sales: 411,
        orders: 9,
        acos: 137 / 411,
        complete: true
      },
      after: {
        start: '2026-06-09',
        end: '2026-06-15',
        spend: 149,
        sales: 447,
        orders: 11,
        acos: 149 / 447,
        complete: true
      },
      mature: true,
      events: []
    };
    return {
      ...common,
      gated: <DaypartingScreen data={{
        view: 'gated',
        props: { entry: { state: 'no-database' } }
      }} />,
      empty: <DaypartingScreen data={{
        view: 'empty',
        props: {}
      }} />,
      'no-schedule': <DaypartingScreen data={emptyDayparting} />,
      ...Object.fromEntries((['draft', 'reviewed', 'enabled', 'paused'] as const).map(status => [status, <DaypartingWorkspaceView data={daypartingFixture(status)} measurement={measurement} />])),
      suggestions: <DaypartingWorkspaceView data={{
        ...data,
        proposals: [suggestion]
      }} measurement={measurement} initialTab="suggestions" />,
      insufficient: <DaypartingWorkspaceView data={data} measurement={measurement} initialTab="suggestions" />,
      'hourly-unavailable': <DaypartingWorkspaceView data={data} measurement={measurement} initialSurface="evidence" />,
      'hourly-available': <DaypartingWorkspaceView data={measuredDaypartingFixture()} measurement={<HourlyMeasurement {...measuredDaypartingFixture()} />} initialSurface="evidence" initialEvidence={dayEvidence} />,
      'review-not-reviewed': <DaypartingWorkspaceView data={data} measurement={measurement} initialSurface="review" />,
      'review-evidence-reviewed': <DaypartingWorkspaceView data={daypartingFixture('reviewed')} measurement={measurement} initialSurface="review" initialEvidence={dayEvidence} />,
      'results-pending': <DaypartingResultsView schedule={syntheticSchedule('enabled')} results={{
        ...result,
        mature: false
      }} currencyCode="USD" />,
      'results-mature': <DaypartingResultsView schedule={syntheticSchedule('enabled')} results={result} currencyCode="USD" />,
      'stop-confirmation': <ScheduleExecutionStatus schedule={syntheticSchedule('enabled')} onReview={() => { }} onResults={() => { }} initialStopOpen />
    };
  }
  return {
    ...common,
    gated: <BrandScreen data={{ view: 'gated' }} />,
    empty: <BrandScreen data={{ view: 'empty' }} />,
    setup: <BrandLens data={{ ...brandReady, source: { ...brandReady.source, vocabulary: [
      ...brandReady.source.vocabulary,
      ...(['competitor_brand', 'core_term'] as const).map((kind, index) => ({ ...brandReady.source.vocabulary[0]!, id: `11111111-1111-4111-8111-11111111111${index + 2}`, kind, value: index ? 'synthetic category' : 'synthetic rival', normalizedValue: index ? 'synthetic category' : 'synthetic rival', source: 'operator' as const })),
    ] } }} />,
    'no-model-proposals': <BrandLens data={{
      ...brandReady,
      source: {
        ...brandReady.source,
        vocabulary: []
      }
    }} />,
    review: <BrandLens data={brandReady} initialTab="review" />,
    ...Object.fromEntries((['kept', 'confirmed', 'changed'] as const).map(decision => [decision, <BrandLens data={{
      ...brandReady,
      source: {
        ...brandReady.source,
        overrides: [{
          orgId: brandReady.profile.id,
          profileId: brandReady.profile.id,
          normalizedKeyword: 'plain component',
          bucket: 'generic',
          decision,
          decidedBy: brandReady.profile.id,
          decidedAt: '2026-06-01T00:00:00Z'
        }]
      }
    }} initialTab="review" />])),
    overview: <BrandLens data={brandReady} initialTab="overview" />,
    'overview-measured': <BrandLens data={{ ...brandReady, profile: { ...brandReady.profile, targetAcos: 0.37 }, source: { ...brandReady.source, keywords: brandReady.source.keywords.map((keyword, index) => index ? keyword : { ...keyword, sales: 36, orders: 2 }) } }} initialTab="overview" />,
    undefined: <BrandLens data={{
      ...brandReady,
      source: {
        ...brandReady.source,
        keywords: []
      }
    }} initialTab="overview" />,
    exclusions: <BrandLens data={{ ...brandReady, source: { ...brandReady.source, campaigns: [...brandReady.source.campaigns, { ...brandReady.source.campaigns[0]!, id: 'synthetic-campaign-three', name: 'Synthetic campaign three', excluded: true }] } }} initialTab="exclusions" />
  };
}
