/** Render production components against synthetic states, outside Playwright's JSX transform. */
import React, { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime.js';
import { SpWriteRecordedPreview, spWriteExecutionRequirements } from '@wizard-ads/shared/sp-write-application';
import { confirmationProposals } from '../../src/screens/optimizer-confirm/render-fixture';
import { referenceRows, review, reviewHold, syntheticProfile, tracedReference, unchangedTarget } from '../../src/screens/optimizer-review/render-fixture';
import { operationFixture } from '../../src/screens/optimizer-run/render-fixture';
import { workedPlacementInputs, workedPlacementRow, workedPeakExposures } from '../../src/screens/optimizer-review/worked-example';
import { spWriteApprovalFixtures, spWriteTwoChangeApprovalFixture } from '../../src/writes/approval-fixtures';
import { chooserReady, chooserRows } from '../../src/screens/optimizer/choose-fixture';
import { restoreApprovalFixture, restoreExportFixture, restoreOperationFixture, type RestoreResultState } from '../../src/writes/approval-fixtures';

Object.assign(globalThis, { React });
const styles = new Map<string, string>();
registerHooks({ load(url, context, nextLoad) {
  if (!url.endsWith('.module.css')) return nextLoad(url, context);
  const css = readFileSync(new URL(url), 'utf8');
  const namespace = `wp269-module-${styles.size}`;
  const classes = Object.fromEntries([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((match) => [match[1], `${namespace}-${match[1]}`]));
  // CSS modules isolate selectors in the app; retain that isolation in static state captures.
  styles.set(url, css.replace(/\.([a-zA-Z][\w-]*)/g, (_, name: string) => `.${classes[name]}`));
  return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(classes)}` };
} });
const { ReviewContent, CalculationContent, InfoPopover } = await import('../../src/screens/optimizer-review/components');
const { ResultsContent } = await import('../../src/screens/optimizer-run/components');
const { OptimizerFrame, OptimizerUnavailable } = await import('../../src/screens/optimizer/frame');
const { OptimizationHelp } = await import('../../src/screens/optimizer-help/view');
const { RunDetails } = await import('../../src/screens/optimizer-review/details');
const { ConfirmContent } = await import('../../src/screens/optimizer-confirm/view');
const { RestoreExportContent } = await import('../../src/screens/optimizer-confirm/restore-export');
const { RetryReview, PreparedRetryReview } = await import('../../src/screens/optimizer-run/view');
const { default: Loading } = await import('../../src/screens/shared-loading');
const { default: ErrorView } = await import('../../src/screens/shared-error');
const { default: ChooseScreen } = await import('../../src/screens/optimizer/view');
const { RunSettings } = await import('../../src/screens/optimizer-settings/view');
const noop = () => {};
const router = { back: noop, forward: noop, refresh: noop, push: noop, replace: noop, prefetch: noop, bfcacheId: 'synthetic-optimizer-render' };
const frame = (title: string, component: ReactElement, step?: 1 | 2 | 3) => createElement(OptimizerFrame, { title, step, children: component });
const details = createElement(RunDetails, { review, currencyCode: 'USD', marketplace: 'US' });
const selection = (ids: string[], initialTab: 'suggestions' | 'unchanged' | 'blocked' | 'details' = 'suggestions', retry = false) => frame(retry ? 'Review unresolved change' : 'Review suggestions', createElement(ReviewContent, {
  rows: retry ? [referenceRows[1]!] : referenceRows, holds: retry ? [] : [reviewHold], unchanged: retry ? [] : [unchangedTarget],
  evaluatedTargets: retry ? 1 : 4, selected: new Set(ids), onToggle: noop, onContinue: noop, onClear: noop,
  profileId: syntheticProfile.id, batchId: review.batchId, currencyCode: 'USD', initialTab, details,
  ...(retry ? { retry: { excludedSuccessfulNames: ['Synthetic target A'] } } : {}),
}), 2);
const result = (state: Parameters<typeof operationFixture>[0], retry = false) => {
  const operation = operationFixture(state);
  return frame(retry ? 'Retry results' : state === 'applying' ? 'Applying changes' : 'Run results', createElement(ResultsContent, {
    ...operation, rows: operation.rows.map((row) => ({ ...row, reason: row.reason ?? undefined })), profileId: operation.plan.profileId, batchId: review.batchId, onRetry: noop,
    ...(state === 'queued' ? { executionGate: { enabled: false, name: spWriteExecutionRequirements.dispatchGate.environmentVariable } } : {}),
    ...(retry ? { retry: { excludedSuccessfulNames: ['Synthetic earlier success'] } } : {}), details,
  }), 3);
};
const approvals = await spWriteApprovalFixtures();
const restoreApproval = await restoreApprovalFixture();
const confirm = (recorded: SpWriteRecordedPreview, retry = false) => createElement(ConfirmContent, { recorded, proposals: confirmationProposals(recorded), batchId: review.batchId, onConfirm: noop, onRefresh: noop, ...(retry ? { retry: { excludedSuccessfulNames: ['Synthetic earlier success'] } } : {}) });
const views: Record<string, ReactElement> = {
  'choose-campaigns': createElement(ChooseScreen, { data: chooserReady }),
  'run-settings': createElement(RunSettings, { data: chooserReady, initialDraft: { campaignIds: chooserRows.map((row) => row.campaignId) } }),
  'missing-group-setting': createElement(RunSettings, {
    data: { ...chooserReady, props: { ...chooserReady.props, campaignRows: [{ ...chooserRows[0]!, oneTimeSettings: { ...chooserRows[0]!.oneTimeSettings, targetAcos: 0 } }] } },
    initialDraft: { campaignIds: [chooserRows[0]!.campaignId], configuration: {
      version: 1, method: 'sp.reference-efficiency', targetAcos: .37, bidFloor: .11, bidCeiling: 4.3,
      bidIncreaseCap: .23, bidDecreaseCap: .41, window: { start: '2026-07-01', end: '2026-07-28' },
    } },
  }),
  loading: createElement(Loading), error: createElement(ErrorView, { error: Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-optimizer' }), reset: noop }),
  gated: createElement(OptimizerUnavailable, { message: 'The database is unavailable. Reconnect before requesting suggestions.' }),
  empty: createElement(OptimizerUnavailable, { message: 'No profiles yet. Connect Amazon Ads to choose campaigns.' }),
  'review-none': selection([]), 'review-first': selection([referenceRows[0]!.id]), 'review-second': selection([referenceRows[1]!.id]), 'review-both': selection(referenceRows.map((row) => row.id)),
  unchanged: selection([], 'unchanged'), blocked: selection([], 'blocked'), 'run-details': selection([], 'details'),
  'calculation-recorded': frame('Calculation details', createElement(CalculationContent, { row: tracedReference, currencyCode: 'USD', backHref: '/optimizer' })),
  'calculation-unavailable': frame('Calculation details', createElement(CalculationContent, { row: referenceRows[0]!, currencyCode: 'USD', backHref: '/optimizer' })),
  shadow: frame('Placement calculation', createElement(CalculationContent, { row: workedPlacementRow, currencyCode: 'USD', backHref: '/optimizer', peakExposureByStep: workedPeakExposures })),
  'shadow-full': frame('Placement calculation', createElement(CalculationContent, { row: workedPlacementRow, currencyCode: 'USD', backHref: '/optimizer', peakExposureByStep: workedPeakExposures, placementInputs: workedPlacementInputs, workedExample: true })),
  'exposure-info': frame('Maximum exposure', createElement(InfoPopover, { label: 'About maximum exposure', initialOpen: true, children: 'Base bid × the applicable placement and audience multipliers. This is a configured maximum, not a forecast of realized CPC.' })),
  'confirm-first': confirm(approvals.ready), 'confirm-second': confirm(SpWriteRecordedPreview.parse({ ...approvals.ready, currentRows: approvals.ready.currentRows.map((row) => ({ ...row, entityName: 'Synthetic second keyword' })) })),
  'confirm-both': confirm(await spWriteTwoChangeApprovalFixture(approvals.ready)), stale: confirm(approvals.stale), refused: confirm(approvals.unavailable),
  'approved-waiting': result('queued'), applying: result('applying'), 'partial-result': result('partial'), 'single-result': result('single'), 'ambiguous-result': result('ambiguous'),
  'retry-stale': frame('Refresh this preview', createElement(RetryReview, { operation: operationFixture('partial'), onBack: noop })),
  'retry-preview': frame('Review unresolved change', createElement(PreparedRetryReview, {
    saved: { preview: approvals.ready.preview, excludedSuccessfulRows: [{ applyRowId: '77777777-7777-4777-8777-777777777777', name: 'Synthetic earlier success' }] },
    proposals: confirmationProposals(approvals.ready), onBack: noop, onReview: noop,
  }), 2), 'retry-confirm': confirm(approvals.ready, true), 'retry-result': result('retry', true),
  help: createElement(OptimizationHelp, { profileId: syntheticProfile.id }), 'worked-example': createElement(OptimizationHelp, { profileId: syntheticProfile.id, example: true }),
  'restore-confirm': confirm(restoreApproval),
  'restore-stale': confirm({ ...restoreApproval, freshness: { ...restoreApproval.freshness, status: 'stale', reasons: ['current_value_changed'] } }),
  'restore-unavailable': confirm({ ...restoreApproval, freshness: { ...restoreApproval.freshness, status: 'unavailable', reasons: ['entity_unavailable'] } }),
  'restore-environment-disabled': confirm({ ...restoreApproval, gates: { environmentEnabled: false, profileAllowlisted: true }, freshness: { ...restoreApproval.freshness, status: 'stale', reasons: ['gate_disabled'] } }),
  'restore-profile-disabled': confirm({ ...restoreApproval, gates: { environmentEnabled: true, profileAllowlisted: false }, freshness: { ...restoreApproval.freshness, status: 'stale', reasons: ['grant_changed'] } }),
  'restore-export': createElement(RestoreExportContent, { data: await restoreExportFixture(), currencyCode: 'USD' }),
  ...Object.fromEntries((['queued', 'applying', 'partial', 'single', 'retry', 'ambiguous', 'failed', 'refused', 'conflict'] satisfies RestoreResultState[]).map((state) => {
    const operation = restoreOperationFixture(state);
    return [`restore-${state}`, frame(state === 'retry' ? 'Retry results' : 'Restore results', createElement(ResultsContent, { ...operation, rows: operation.rows.map((row) => ({ ...row, reason: row.reason ?? undefined })), profileId: operation.plan.profileId, batchId: review.batchId, onRetry: noop, ...(state === 'retry' ? { retry: { excludedSuccessfulNames: ['Synthetic completed restore'] } } : {}) }), 3)];
  })),
  'restore-retry-confirm': confirm(restoreApproval, true),
  'restore-retry-preview': frame('Review unresolved change', createElement(PreparedRetryReview, { saved: { preview: restoreApproval.preview, excludedSuccessfulRows: [{ applyRowId: '77777777-7777-4777-8777-777777777777', name: 'Synthetic completed restore' }] }, onBack: noop, onReview: noop }), 2),
};
const markup = Object.fromEntries(Object.entries(views).map(([state, view]) => [state, renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router, children: view }))]));
const css = readFileSync(new URL('../../../../packages/ui/src/tokens.css', import.meta.url), 'utf8') + '\n' + [...styles.values()].join('\n');
process.stdout.write(JSON.stringify({ states: Object.keys(views), markup, css }));
