import {
  ResolvedBidSettings, type EntityRef, type Hold, type MethodSelection, type ResolvedSetting,
} from '@wizard-ads/shared';

type BidField = keyof ResolvedBidSettings;
export interface ResolveMethodBidSettingsInput {
  entity: EntityRef;
  group: { name: string; values: Partial<Record<BidField, number | null>> } | null;
  /** Already sourced run fields, including visible tenant strategy values for saved-policy runs. */
  run: Partial<Record<BidField, ResolvedSetting<number>>>;
}

/** Each assigned group value wins. Absence is never converted to a numeric policy. */
export function resolveMethodBidSettings(input: ResolveMethodBidSettingsInput):
  { kind: 'resolved'; settings: ResolvedBidSettings } | { kind: 'hold'; hold: Hold } {
  const settings: Partial<Record<BidField, ResolvedSetting<number>>> = {};
  const missing: BidField[] = [];
  for (const field of Object.keys(ResolvedBidSettings.shape) as BidField[]) {
    const groupValue = input.group?.values[field];
    const resolved = groupValue == null ? input.run[field]
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
