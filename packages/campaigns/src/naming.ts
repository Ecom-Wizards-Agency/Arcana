/**
 * Campaign and ad-group names.
 *
 * A name is a list of slots joined by a delimiter, with empty slots dropped.
 * That last part is doing more work than it looks: it is how "Camp Counter is
 * only used for Halo and Auto campaigns" is enforced, and how a preset can
 * carry a slot that a given campaign has nothing to put in.
 *
 * Two presets ship. `LEGACY` is the original six-slot order every pre-existing
 * config uses; `EW` is the eight-slot convention and the default. An explicit
 * `variableOrder` always beats a preset.
 */
import { MATCH_TYPE_LABELS, type MatchType } from './constants.js';
import type { NamingSettings } from './types.js';

/** What a name slot is filled from. Every field is optional but `goal`. */
export interface NamingContext {
  goal: string;
  campaignType: string;
  matchType: string;
  productName?: string;
  targetDescriptor?: string;
  triggerWord?: string;
  keywordText?: string;
  counter?: number | null;
}

export const LEGACY_NAMING_PRESET: NamingSettings = {
  variableOrder: ['Goal', 'SP', 'MatchType', 'ProductName', 'TargetDescriptor', 'EW'],
  delimiter: ' | ',
  suffix: 'EW',
  custom1Value: '',
  custom2Value: '',
};

export const EW_NAMING_PRESET: NamingSettings = {
  variableOrder: [
    'Goal', 'AdType', 'MatchType', 'TriggerWord', 'ProductName', 'Keyword', 'CampCounter', 'EW',
  ],
  delimiter: ' | ',
  suffix: 'EW',
  custom1Value: '',
  custom2Value: '',
};

export const NAMING_PRESETS: Record<string, NamingSettings> = {
  LEGACY: LEGACY_NAMING_PRESET,
  EW: EW_NAMING_PRESET,
};

/** The default when a config names no preset and no explicit order. */
export const DEFAULT_NAMING_PRESET = EW_NAMING_PRESET;

/**
 * Slots dropped from an ad-group name: it is the shorter form of the campaign
 * name, without the prefix and suffix.
 *
 * `SP` is deliberately NOT in this set. The legacy preset keeps it in the ad
 * group name, and that is what the parity fixtures record; the EW preset uses
 * `AdType` for the same slot, so dropping `AdType` changes the new preset only.
 */
const AD_GROUP_DROPPED_SLOTS = new Set(['Goal', 'EW', 'Counter', 'Date', 'AdType', 'CampCounter']);

/** Two-digit counter, the way the source app renders it. */
function counterToken(counter: number): string {
  return counter < 10 ? `0${counter}` : String(counter);
}

/** `YYYYMMDD` from an ISO date. The date slot is the only clock-shaped one. */
function dateToken(isoDate: string): string {
  return isoDate.replaceAll('-', '');
}

function slotValue(
  variable: string,
  ctx: NamingContext,
  settings: NamingSettings,
  today: string,
): string {
  switch (variable) {
    case 'Goal':
      return ctx.goal;
    case 'SP':
    case 'AdType':
      return 'SP';
    case 'MatchType':
      return MATCH_TYPE_LABELS[ctx.matchType as MatchType] ?? ctx.matchType;
    case 'CampaignType':
      // The reference keeps an identity map here so the slot has a hook for a
      // future relabel. Until one exists, the type is its own label.
      return ctx.campaignType;
    case 'TriggerWord':
      return ctx.triggerWord || ctx.campaignType;
    case 'ProductName':
      return ctx.productName || 'ProductName';
    case 'Keyword':
      return ctx.keywordText ?? '';
    case 'TargetDescriptor':
      return ctx.targetDescriptor || 'Target';
    case 'EW':
      return settings.suffix || 'EW';
    case 'Counter':
      return ctx.counter === null || ctx.counter === undefined ? '' : counterToken(ctx.counter);
    case 'CampCounter':
      // Only Halo and Auto carry a campaign counter; for everything else the
      // empty string is how "leave it off" is expressed, because a blank slot
      // is dropped when the name is joined.
      if ((ctx.campaignType === 'Halo' || ctx.campaignType === 'Auto')
        && ctx.counter !== null && ctx.counter !== undefined) {
        return counterToken(ctx.counter);
      }
      return '';
    case 'Date':
      return dateToken(today);
    case 'Custom1':
      return settings.custom1Value || '';
    case 'Custom2':
      return settings.custom2Value || '';
    default:
      // An unknown slot renders as its own name, which makes a typo in a
      // config visible in the campaign name instead of silently missing.
      return variable;
  }
}

export function generateCampaignName(
  settings: NamingSettings,
  ctx: NamingContext,
  today: string,
): string {
  return settings.variableOrder
    .map((variable) => slotValue(variable, ctx, settings, today))
    .filter((part) => part !== '')
    .join(settings.delimiter);
}

export function generateAdGroupName(
  settings: NamingSettings,
  ctx: NamingContext,
  today: string,
): string {
  return settings.variableOrder
    .filter((variable) => !AD_GROUP_DROPPED_SLOTS.has(variable))
    .map((variable) => slotValue(variable, ctx, settings, today))
    .filter((part) => part !== '')
    .join(settings.delimiter);
}

/** Swap the product and descriptor slots, when a spec asks for it. */
export function swapNameOrder(settings: NamingSettings): NamingSettings {
  const order = [...settings.variableOrder];
  const product = order.indexOf('ProductName');
  const descriptor = order.indexOf('TargetDescriptor');
  if (product === -1 || descriptor === -1) return settings;
  order[product] = 'TargetDescriptor';
  order[descriptor] = 'ProductName';
  return { ...settings, variableOrder: order };
}

/**
 * Resolve a partial naming block against a preset.
 *
 * An explicit `variableOrder` wins over the preset, which is what keeps every
 * config written before the EW preset existed generating the same names.
 */
export function resolveNaming(
  input: (Partial<NamingSettings> & { preset?: string }) | undefined,
): NamingSettings {
  const preset = NAMING_PRESETS[(input?.preset ?? '').toUpperCase()] ?? DEFAULT_NAMING_PRESET;
  return {
    variableOrder: input?.variableOrder ?? preset.variableOrder,
    delimiter: input?.delimiter ?? preset.delimiter,
    suffix: input?.suffix ?? preset.suffix,
    custom1Value: input?.custom1Value ?? preset.custom1Value,
    custom2Value: input?.custom2Value ?? preset.custom2Value,
  };
}

export interface ParsedCampaignName {
  slots: Partial<Record<string, string>>;
  confidence: 'exact' | 'partial' | 'none';
}

/**
 * Reverse the preset grammar. Empty optional slots may have been dropped by
 * the builder. Keep only values shared by every valid alignment; never shift
 * an arbitrary word into the Keyword slot to make an incomplete name fit.
 */
export function parseCampaignName(name: string, preset: NamingSettings): ParsedCampaignName {
  const none: ParsedCampaignName = { slots: {}, confidence: 'none' };
  const order = preset.variableOrder;
  if (!name.trim() || !preset.delimiter || order.length === 0
    || new Set(order).size !== order.length) return none;
  const parts = name.split(preset.delimiter);
  if (parts.length > order.length || (order.length > 1 && parts.length === 1)) return none;
  const optional = new Set(['Keyword', 'Counter', 'CampCounter', 'Custom1', 'Custom2']);
  const free = new Set(['Goal', 'CampaignType', 'TriggerWord', 'ProductName', 'Keyword', 'TargetDescriptor']);
  const accepts = (slot: string, value: string): boolean => {
    if (!value || value !== value.trim()) return false;
    if (free.has(slot)) return true;
    switch (slot) {
      case 'SP': return value === 'SP';
      case 'AdType': return ['SP', 'SB', 'SB Video', 'SD'].includes(value);
      case 'MatchType': return Object.values(MATCH_TYPE_LABELS).includes(value) || value === 'Auto';
      case 'EW': return value === (preset.suffix || 'EW');
      case 'Counter':
      case 'CampCounter': return /^\d{2,}$/.test(value);
      case 'Date': return /^\d{8}$/.test(value);
      case 'Custom1': return value === preset.custom1Value;
      case 'Custom2': return value === preset.custom2Value;
      default: return value === slot;
    }
  };
  // Memoized suffix alignments avoid exponential work for many optional slots.
  const memo = new Map<string, Partial<Record<string, string>> | null>();
  const align = (slotIndex: number, partIndex: number): Partial<Record<string, string>> | null => {
    const key = `${slotIndex}:${partIndex}`;
    if (memo.has(key)) return memo.get(key)!;
    if (slotIndex === order.length) return partIndex === parts.length ? {} : null;
    const slot = order[slotIndex]!;
    const value = parts[partIndex];
    const candidates: Partial<Record<string, string>>[] = [];
    if (value !== undefined && (value === '' || accepts(slot, value))) {
      const tail = align(slotIndex + 1, partIndex + 1);
      if (tail !== null) candidates.push(value === '' ? tail : { ...tail, [slot]: value });
    }
    if (optional.has(slot)) {
      const tail = align(slotIndex + 1, partIndex);
      if (tail !== null) candidates.push(tail);
    }
    const first = candidates[0];
    const common = first === undefined ? null : Object.fromEntries(
      Object.entries(first).filter(([field, token]) => candidates.every((candidate) => candidate[field] === token)),
    );
    memo.set(key, common);
    return common;
  };
  const slots = align(0, 0);
  if (slots === null || Object.keys(slots).length === 0) return none;
  return {
    slots,
    confidence: parts.length === order.length && Object.keys(slots).length === order.length ? 'exact' : 'partial',
  };
}

/** A keyword is usable only when every matching preset identifies the same slot. */
export function keywordFromCampaignName(name: string, presets: readonly NamingSettings[]): string | null {
  const matches = presets.map((preset) => parseCampaignName(name, preset))
    .filter((parsed) => parsed.confidence !== 'none');
  const keyword = matches[0]?.slots['Keyword'];
  return keyword !== undefined && matches.every((parsed) => parsed.slots['Keyword'] === keyword)
    ? keyword : null;
}
