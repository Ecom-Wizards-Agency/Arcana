'use client';

import { gateMessage } from '../../ui/gate-message';
import { OptimizerFrame } from '../optimizer/frame';
import { CalculationContent, optimizerStyles } from '../optimizer-review/components';
import { workedDependencySet, workedPeakExposures, workedPlacementInputs, workedPlacementRow } from '../optimizer-review/worked-example';
import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;

export function OptimizationHelp({ profileId, example = false }: { profileId: string; example?: boolean }) {
  const query = `profile=${encodeURIComponent(profileId)}`;
  if (example) return <OptimizerFrame title="Worked placement example"><CalculationContent row={workedPlacementRow} profileId={profileId} currencyCode="USD" backHref={`/optimizer/help?${query}`} dependencySet={workedDependencySet} peakExposureByStep={workedPeakExposures} placementInputs={workedPlacementInputs} workedExample /></OptimizerFrame>;
  return <OptimizerFrame title="How optimization works">
    <div style={optimizerStyles.stack}>
      <section style={optimizerStyles.card}><h2>Review what changes</h2><p>Choose campaigns, get suggestions, select changes and review the exact values. Your final confirmation records approval for those values in Amazon. The worker executes approved changes only when its execution gate and profile permissions allow it.</p><p>Settings and calculations are optional detours. Viewing a suggestion does not send a change.</p></section>
      <section style={optimizerStyles.card}><h2>Understand a suggestion</h2><p>Open View calculation for the recorded inputs, formula steps, bounds and rounded result. Older rows may lack a saved calculation. In that case Arcana shows the saved bids and their percentage difference, and names the missing calculation evidence.</p><a href={`/optimizer/help?${query}&example=placement`}>View worked placement example</a></section>
      <section style={optimizerStyles.card}><h2>Changes that depend on each other</h2><p>A base bid and its placement adjustments can form one dependent set. Select and review the whole set. Its calculation records the required write order and configured exposure limits. If a dependent write fails, execution stops and the partial result needs fresh review.</p><p>Holds remain in the run totals. Their reason and affected scope explain what needs to change before another review.</p></section>
      <section style={optimizerStyles.card}><h2>Method availability</h2><p>Stable methods can be used where supported. Shadow methods produce previews only. Draft methods cannot be selected. The reference method is derived from AdLabs; live parity has not been established.</p><a href={`/settings/strategy?${query}`}>Methods and release states</a><p><a href={`/settings/strategy?${query}&tab=identifiers`}>Method identifiers</a></p></section>
      <div style={optimizerStyles.actions}><a href={`/optimizer?${query}`}>Return to Optimize Now</a></div>
    </div>
  </OptimizerFrame>;
}

export default function ScreenView({ data }: { data: ScreenData }) {
  if (data.view === 'gated') return <OptimizerFrame title="How optimization works"><p>{gateMessage(data.props.entry.state)}</p></OptimizerFrame>;
  if (data.view === 'empty') return <OptimizerFrame title="How optimization works"><p>No profiles yet. Connect an advertising profile to review its optimization methods.</p><a href="/settings/connections">Review connections</a></OptimizerFrame>;
  return <OptimizationHelp {...data.props} />;
}
