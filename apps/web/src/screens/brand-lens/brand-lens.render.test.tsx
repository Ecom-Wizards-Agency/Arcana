// @vitest-environment jsdom
import Loading from '../../../app/brand-lens/loading';
import { verifyScreen } from '../render-test-support';
import SharedError from '../shared-error';
import { descriptor } from './descriptor';
import Screen, { BrandLens } from './view';
import { brandReady } from './render-fixture';
verifyScreen(descriptor, [
  {
    state: 'loading',
    name: 'loading',
    render: () => <Loading />,
    text: ''
  },
  {
    state: 'error',
    name: 'error',
    render: () => <SharedError error={new Error('Synthetic failure')} reset={() => { }} />,
    text: 'Try'
  },
  {
    state: 'gated',
    name: 'gated',
    render: () => <Screen data={{ view: 'gated' }} />,
    text: 'unavailable'
  },
  {
    state: 'empty',
    name: 'empty',
    render: () => <Screen data={{ view: 'empty' }} />,
    text: 'No profiles'
  },
  {
    state: 'not-measured',
    name: 'undefined performance',
    render: () => <BrandLens data={{
      ...brandReady,
      source: {
        ...brandReady.source,
        keywords: []
      }
    }} initialTab="overview" />,
    text: 'No keyword performance'
  },
  {
    state: 'ready',
    name: 'setup with proposals',
    render: () => <Screen data={brandReady} />,
    text: 'model proposed 1 · you kept 1'
  },
  {
    state: 'ready',
    name: 'setup without model proposals',
    render: () => <Screen data={{
      ...brandReady,
      source: {
        ...brandReady.source,
        vocabulary: []
      }
    }} />,
    text: 'No model proposals yet'
  },
  {
    state: 'ready',
    name: 'review with unmatched keyword',
    render: () => <BrandLens data={brandReady} initialTab="review" />,
    text: 'no token matched'
  },
  {
    state: 'ready',
    name: 'bucket overview with data',
    render: () => <BrandLens data={brandReady} initialTab="overview" />,
    text: '54.5%'
  },
  {
    state: 'ready',
    name: 'grouped and ungrouped exclusions',
    render: () => <BrandLens data={brandReady} initialTab="exclusions" />,
    text: 'Assign to a group first'
  },
  ...(['kept', 'confirmed', 'changed'] as const).map(decision => ({
    state: 'ready' as const,
    name: `${decision} decision`,
    render: () => <BrandLens data={{
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
    }} initialTab="review" />,
    text: decision
  })),
]);
