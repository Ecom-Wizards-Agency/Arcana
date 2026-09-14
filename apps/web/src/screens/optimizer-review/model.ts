import type { RecommendationRecord } from '@wizard-ads/db';
import type { DependencySet, Hold, MethodEvaluatorInput } from '@wizard-ads/shared';

export interface UnchangedTarget {
  id: string;
  name: string;
  campaignName: string | null;
  currentValue: number | string | null;
  proposedValue: number | string | null;
  reason: string;
}

export interface ReviewUnit {
  id: string;
  rows: readonly RecommendationRecord[];
  dependencySet: DependencySet | null;
  logicalChanges: number;
  selectable: boolean;
  shadow: boolean;
}

/** One saved dependency is one selection, even when several rows reference it. */
export function reviewUnits(rows: readonly RecommendationRecord[]): ReviewUnit[] {
  const grouped = new Map<string, RecommendationRecord[]>();
  for (const row of rows) {
    const key = row.inputs.dependencySet?.id ?? row.id;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return [...grouped.entries()].map(([id, members]) => {
    const dependencySet = members[0]?.inputs.dependencySet ?? null;
    return {
      id, rows: members, dependencySet,
      logicalChanges: dependencySet?.changes.length ?? members.length,
      selectable: members.every((row) => row.status === 'proposed' || row.status === 'accepted'),
      shadow: members.some((row) => row.inputs.methodId === 'sp.coordinated-efficiency'),
    };
  });
}

export function selectedChangeCount(units: readonly ReviewUnit[], selected: ReadonlySet<string>): number {
  return units.reduce((sum, unit) => sum + (unit.rows.every((row) => selected.has(row.id)) ? unit.logicalChanges : 0), 0);
}

export function selectedIncludesShadow(units: readonly ReviewUnit[], selected: ReadonlySet<string>): boolean {
  return units.some((unit) => unit.shadow && unit.rows.some((row) => selected.has(row.id)));
}

export function changedPercent(current: unknown, proposed: unknown): number | null {
  return typeof current === 'number' && current !== 0 && typeof proposed === 'number'
    ? (proposed - current) / current * 100 : null;
}

export function displayValue(value: unknown): string {
  if (value === null || value === undefined) return 'Unavailable';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function targetName(row: RecommendationRecord): string { return row.entityName ?? row.entityId; }

export function holdScope(hold: Hold): string {
  return hold.affectedScope.map((entity) => `${entity.entityType} ${entity.entityId}`).join(' · ');
}

/** Evidence comes only from recorded inputs. Absent facts never become zero. */
export function recordedMetric(row: RecommendationRecord, names: readonly string[]): string {
  for (const step of row.inputs.trace?.steps ?? []) {
    const input = step.inputs.find((candidate) => names.includes(candidate.name.toLowerCase()));
    if (input !== undefined) return displayValue(input.value);
  }
  return 'Unavailable';
}

/** These are saved evaluator results, never a replay from the displayed controls. */
export function recordedDependencyExposures(row: RecommendationRecord): readonly (number | null)[] | undefined {
  const set = row.inputs.dependencySet;
  if (!set || !row.inputs.trace) return undefined;
  return set.changes.map((_, index) => {
    const matches = row.inputs.trace!.steps.filter((step) => step.label === `Intermediate exposure: step ${index + 1}`);
    return matches.length === 1 ? matches[0]!.result : null;
  });
}

export interface RecordedPlacementInput {
  placement: string;
  clicks: number;
  revenue: number;
  rpc: number | null;
  clickShare: number;
}

/** Match the saved campaign snapshot; RPC is a recorded trace result, never a replay. */
export function recordedPlacementInputs(row: RecommendationRecord, snapshots: readonly MethodEvaluatorInput[]): RecordedPlacementInput[] | undefined {
  const matches = snapshots.filter((snapshot) => snapshot.methodId === 'sp.coordinated-efficiency'
    && snapshot.runId === row.runId && snapshot.profileId === row.profileId
    && snapshot.methodId === row.inputs.methodId && snapshot.methodVersion === row.inputs.methodVersion
    && snapshot.campaignEvidence.campaignId === row.campaignId);
  const snapshot = matches.length === 1 ? matches[0] : undefined;
  if (snapshot?.methodId !== 'sp.coordinated-efficiency') return undefined;
  const names = { top_of_search: 'Top of search', rest_of_search: 'Rest of search', product_pages: 'Product pages' };
  const facts = snapshot.campaignEvidence.placementFacts;
  if (facts.some((fact) => fact.campaignId !== row.campaignId) || new Set(facts.map((fact) => fact.placement)).size !== facts.length) return undefined;
  return facts.map((fact) => {
    const steps = row.inputs.trace?.steps.filter((step) => step.label === `RPC: ${fact.placement}`
      && step.inputs.some((input) => input.name === 'sales' && input.value === fact.sales)
      && step.inputs.some((input) => input.name === 'clicks' && input.value === fact.clicks)) ?? [];
    return { placement: names[fact.placement], clicks: fact.clicks, revenue: fact.sales,
      clickShare: fact.clickShare, rpc: steps.length === 1 ? steps[0]!.result : null };
  });
}
