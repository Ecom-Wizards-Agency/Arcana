import {
  ResolvedBidSettings, ResolvedCoordinatedSettings, type CoordinatedMethodSettings, type EntityRef, type Hold, type MethodSelection, type ResolvedSetting,
} from '@wizard-ads/shared';

type BidField = keyof ResolvedBidSettings;
export interface ResolveMethodBidSettingsInput {
  entity: EntityRef;
  group: { name: string; values: Partial<Record<BidField, number | null>> } | null;
  /** Already sourced run fields, including visible tenant strategy values for saved-policy runs. */
  run: Partial<Record<BidField, ResolvedSetting<number>>>;
}

/** Each assigned group value wins; defaults cannot fill a missing assigned-group setting. */
export function resolveMethodBidSettings(input: ResolveMethodBidSettingsInput):
  { kind: 'resolved'; settings: ResolvedBidSettings } | { kind: 'hold'; hold: Hold } {
  const settings: Partial<Record<BidField, ResolvedSetting<number>>> = {};
  const missing: BidField[] = [];
  for (const field of Object.keys(ResolvedBidSettings.shape) as BidField[]) {
    const groupValue = input.group?.values[field];
    const fallback = input.run[field];
    const resolved = groupValue == null
      ? input.group !== null && fallback?.source === 'default' ? undefined : fallback
      : { value: groupValue, source: 'group' as const, sourceLabel: input.group!.name };
    if (resolved === undefined) missing.push(field);
    else settings[field] = resolved;
  }
  if (missing.length > 0) return { kind: 'hold', hold: {
    reason: 'MISSING_SETTING', prose: `Required bid settings are missing: ${missing.join(', ')}.`,
    affectedScope: [input.entity], reconsiderWhen: 'Supply each missing value in the assigned group or the run settings.',
  } };
  const parsed = ResolvedBidSettings.safeParse(settings);
  if (!parsed.success) return { kind: 'hold', hold: {
    reason: 'MISSING_SETTING', prose: 'A required bid setting has an invalid value.',
    affectedScope: [input.entity], reconsiderWhen: 'Correct the invalid group or run setting.',
  } };
  return { kind: 'resolved', settings: parsed.data };
}

/** Method selection and numeric setting precedence are separate decisions. */
export function resolveCampaignMethod(
  explicit: MethodSelection | undefined, group: MethodSelection | undefined, runDefault: MethodSelection,
): ResolvedSetting<MethodSelection> {
  if (explicit !== undefined) return { value: explicit, source: 'run', sourceLabel: 'Campaign selection for this run' };
  if (group !== undefined) return { value: group, source: 'group', sourceLabel: 'Assigned group method' };
  return { value: runDefault, source: 'default', sourceLabel: 'Run default method' };
}

/** Coordinated settings use the same group-first rule and never invent thresholds. */
export function resolveCoordinatedMethodSettings(input: {
  entity: EntityRef;
  group: { name: string; values: Partial<CoordinatedMethodSettings> } | null;
  run: Partial<CoordinatedMethodSettings>;
}): { kind: 'resolved'; settings: ResolvedCoordinatedSettings } | { kind: 'hold'; hold: Hold } {
  const settings = Object.fromEntries(Object.keys(ResolvedCoordinatedSettings.shape).map((key) => {
    const field = key as keyof CoordinatedMethodSettings;
    const groupValue = input.group?.values[field];
    const value = groupValue ?? input.run[field];
    return [key, { value, source: groupValue === undefined ? 'run' : 'group',
      sourceLabel: groupValue === undefined ? 'This run' : input.group!.name }];
  }));
  const parsed = ResolvedCoordinatedSettings.safeParse(settings);
  if (parsed.success) return { kind: 'resolved', settings: parsed.data };
  return { kind: 'hold', hold: {
    reason: 'MISSING_SETTING', prose: `Coordinated settings are missing or invalid: ${[...new Set(parsed.error.issues.map((issue) => issue.path[0]))].join(', ')}.`,
    affectedScope: [input.entity], reconsiderWhen: 'Supply the required exposure ceiling and placement evidence settings in the assigned group or this run.',
  } };
}
