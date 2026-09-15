import type { ReactElement } from 'react';
import type { SponsoredPrompt, SponsoredPromptObservation, SponsoredPromptSnapshot } from '@wizard-ads/shared';
import Loading from '../shared-loading';
import SharedError from '../shared-error';
import type { SponsoredPromptsData } from './load';
import { PromptsPresentation } from './presentation';

const at = (day: number) => `2026-06-${String(day).padStart(2, '0')}T00:00:00.000Z`;
const observation = (day: number, status: 'live' | 'paused' = 'live'): SponsoredPromptObservation => ({
  observedAt: at(day), status, intervalStart: at(day - 1), intervalEnd: at(day), spend: 3, clicks: 2, sales: 6, orders: 1,
});
export const syntheticPrompt = (index: number, observations: SponsoredPromptObservation[]): SponsoredPrompt => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, adProduct: index % 2 ? 'SB' : 'SP',
  campaignId: `synthetic-campaign-${index}`, adGroupId: `synthetic-group-${index}`,
  campaignName: `Synthetic campaign ${index}`, adGroupName: `Synthetic ad group ${index}`,
  promptText: `Synthetic prompt ${index}`, normalizedPrompt: `synthetic prompt ${index}`,
  firstSeenAt: observations[0]!.observedAt, lastSeenAt: observations.at(-1)!.observedAt,
  currentStatus: observations.at(-1)!.status, observations,
});
export const promptSnapshot: SponsoredPromptSnapshot = {
  profileId: '00000000-0000-4000-8000-000000000081', viewedThrough: at(10), lastVisitedAt: at(3), latestObservationAt: at(7),
  windowStart: '2026-05-11T00:00:00.000Z', windowEnd: at(10),
  prompts: [syntheticPrompt(1, [observation(5)]), syntheticPrompt(2, [observation(2), observation(4, 'paused'), observation(5), observation(6, 'paused'), observation(7)]), syntheticPrompt(3, [observation(2)])],
};
export const ready: Extract<SponsoredPromptsData, { view: 'ready' }> = { view: 'ready', countryCode: 'US', currencyCode: 'USD', canEdit: true, snapshot: promptSnapshot };
export const visualStates = ['loading', 'error', 'gated', 'empty-profile', 'empty', 'newly-sponsored', 'returned', 'unchanged-collapsed', 'unchanged-expanded', 'loop-cost', 'first-visit'] as const;
export type PromptVisualState = typeof visualStates[number];
export function visualFixture(state: string): SponsoredPromptsData {
  if (state === 'gated') return { view: 'gated' };
  if (state === 'empty-profile') return { view: 'empty' };
  const snapshot = { ...promptSnapshot };
  if (state === 'empty') { snapshot.prompts = []; snapshot.latestObservationAt = null; snapshot.lastVisitedAt = null; }
  else if (state === 'newly-sponsored') snapshot.prompts = [promptSnapshot.prompts[0]!];
  else if (state === 'returned') snapshot.prompts = [promptSnapshot.prompts[1]!];
  else if (state.startsWith('unchanged-')) snapshot.prompts = [promptSnapshot.prompts[2]!];
  else if (state === 'first-visit') snapshot.lastVisitedAt = null;
  return { ...ready, snapshot };
}
export function renderVisualFixture(state: string): ReactElement {
  if (state === 'loading') return <Loading />;
  if (state === 'error') return <SharedError error={Object.assign(new Error('Synthetic error'), { digest: 'synthetic-prompts-reference' })} reset={() => {}} />;
  return <PromptsPresentation data={visualFixture(state)} expanded={state === 'unchanged-expanded'} />;
}
