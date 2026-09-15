import { AssetEligibilityEvidence, type AssetLibraryIdentity, type AssetLibraryObservation,
  type AssetModerationContext, type AssetModerationObservation } from '@wizard-ads/shared';

interface Timed<T> { observation: T; expiresAt: string }
const sameIdentity = (left: AssetLibraryIdentity | null, right: AssetLibraryIdentity) => left?.assetId === right.assetId && left.version === right.version;
const sameContext = (left: AssetModerationContext, right: AssetModerationContext) => left.scope.region === right.scope.region
  && left.scope.amazonProfileId === right.scope.amazonProfileId && left.marketplace === right.marketplace && left.program === right.program;
const specificationProgram: Readonly<Record<string, string>> = { SB_VIDEO: 'SPONSORED_BRANDS_VIDEO' };

/** Pure scope/version precedence. Expiry comes from source evidence, never collection time on replay. */
export function deriveAssetEligibility(input: {
  context: AssetModerationContext; identity: AssetLibraryIdentity; now: string;
  asset: Timed<AssetLibraryObservation> | null; moderation: readonly Timed<AssetModerationObservation>[];
}): AssetEligibilityEvidence {
  const base = { context: input.context, identity: input.identity, canRun: 'unknown' as const, selectable: false,
    status: 'unknown' as const, evidenceState: 'missing' as const, reasons: [] as string[], observedAt: null as string | null };
  const finish = (overrides: Partial<AssetEligibilityEvidence>) => AssetEligibilityEvidence.parse({ ...base, ...overrides });
  const now = Date.parse(input.now);
  if (!Number.isFinite(now)) throw new Error('Asset eligibility requires a valid clock');
  const candidates = input.moderation.filter(({ observation }) => observation.stage === 'final'
    && sameContext(observation.context, input.context) && sameIdentity(observation.assetIdentity, input.identity));
  if (!input.asset || !sameIdentity(input.asset.observation.identity, input.identity)
    || input.asset.observation.scope.region !== input.context.scope.region
    || input.asset.observation.scope.amazonProfileId !== input.context.scope.amazonProfileId) return finish({ reasons: ['Exact asset version evidence is missing.'] });
  if (candidates.length === 0) return finish({ evidenceState: 'partial', reasons: ['Final moderation for this asset version and context is missing.'] });
  // Keep the latest state of each subject; a later approval for another ad cannot erase a rejection.
  const latest = new Map<string, Timed<AssetModerationObservation>[]>();
  for (const item of candidates) {
    const key = JSON.stringify(item.observation.subject); const previous = latest.get(key);
    const at = item.observation.observedAt;
    if (!previous || Date.parse(at) > Date.parse(previous[0]!.observation.observedAt)) latest.set(key, [item]);
    else if (Date.parse(at) === Date.parse(previous[0]!.observation.observedAt)) previous.push(item);
  }
  const rows = [...latest.values()].flat();
  const observedAt = rows.map((item) => item.observation.observedAt).sort().at(-1)!;
  const current = (item: { expiresAt: string; observation: { observedAt: string } }) => {
    const observed = Date.parse(item.observation.observedAt), expires = Date.parse(item.expiresAt);
    return Number.isFinite(observed) && Number.isFinite(expires) && observed <= now && expires > now && expires > observed;
  };
  if (!current(input.asset) || rows.some((item) => !current(item))) {
    return finish({ evidenceState: 'stale', observedAt, reasons: ['Asset or moderation evidence is outside its validity window.'] });
  }
  if ([...latest.values()].some((items) => new Set(items.map((item) => item.observation.status)).size > 1)) {
    return finish({ evidenceState: 'partial', observedAt, reasons: ['Conflicting moderation observations require reconciliation.'] });
  }
  const statuses = new Set(rows.map((item) => item.observation.status));
  const reasons = [...new Set(rows.flatMap((item) => item.observation.reasons))];
  if (statuses.has('rejected')) return finish({ canRun: 'ineligible', status: 'rejected', evidenceState: 'measured', observedAt, reasons });
  if (statuses.has('unknown')) return finish({ evidenceState: 'partial', observedAt, reasons });
  if (statuses.has('pending')) return finish({ status: 'pending', canRun: 'ineligible', evidenceState: 'measured', observedAt, reasons });
  const asset = input.asset.observation;
  if (asset.processing !== 'active') return finish({ status: 'approved', canRun: 'ineligible', evidenceState: 'partial', observedAt, reasons: [...reasons, 'The asset is not active.'] });
  const expectedProgram = input.context.program === 'SPONSORED_DISPLAY'
    ? asset.assetType === 'video' ? 'SPONSORED_DISPLAY_VIDEO' : 'LIVE_IMAGE_SPONSORED_DISPLAY'
    : specificationProgram[input.context.program] ?? input.context.program;
  if (!asset.specChecks.approvedPrograms?.includes(expectedProgram) || asset.specChecks.failedSpecChecks?.some((check) => check.program === expectedProgram && check.specifications.some((spec) => !spec.passed))) {
    return finish({ status: 'approved', evidenceState: 'partial', observedAt, reasons: [...reasons, 'Program specification approval is missing or failed.'] });
  }
  return finish({ status: 'approved', canRun: 'eligible', selectable: true, evidenceState: 'measured', observedAt, reasons });
}
