// @vitest-environment jsdom
import { TargetTranslation } from '@wizard-ads/shared';
import { verifyScreen } from '../render-test-support';
import Loading from '../../../app/grid/translation/loading';
import SharedError from '../shared-error';
import Screen from './view';
import { descriptor } from './descriptor';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = TargetTranslation.parse({ id: uuid(3), orgId: uuid(1), profileId: uuid(2), originalText: 'Synthetic original', language: 'en', providerId: 'not-configured', result: { status: 'unavailable', text: null, reason: 'provider not configured' }, provenance: { requestedAt: '2026-09-14T00:00:00Z', completedAt: '2026-09-14T00:00:01Z', requestedBy: uuid(5), requestId: uuid(4) } });
const ready = { view: 'ready' as const, profileId: uuid(2), language: 'en' as const, canRetry: true, rows: [row] };
verifyScreen(descriptor, [
  { state: 'loading', name: 'loads without fabricated rows', render: () => <Loading />, text: 'Loading' },
  { state: 'error', name: 'shows the error reference', render: () => <SharedError error={Object.assign(new Error('Synthetic'), { digest: 'synthetic-reference' })} reset={() => {}} />, text: 'synthetic-reference' },
  { state: 'gated', name: 'requires an authorized account', render: () => <Screen data={{ view: 'gated' }} />, text: 'authorized account' },
  { state: 'empty', name: 'explains an absent profile', render: () => <Screen data={{ view: 'empty' }} />, text: 'Choose a profile' },
  { state: 'not-measured', name: 'retains the original and retry while unavailable', render: () => <Screen data={ready} />, text: 'Synthetic original' },
  { state: 'ready', name: 'shows available wording', render: () => <Screen data={{ ...ready, rows: [{ ...row, result: { status: 'available', text: 'Synthetic translation', reason: null } }] }} />, text: 'Available' },
  { state: 'ready', name: 'shows waiting without replacing the original', render: () => <Screen data={{ ...ready, rows: [{ ...row, result: { status: 'waiting', text: null, reason: null } }] }} />, text: 'Waiting' },
]);
