'use client';

import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { DateRangePicker as SharedDateRangePicker, comparisonRange } from '@wizard-ads/ui';
import type { Period } from '../../app/_lib/periods';
import { dateRangeHref } from './date-range';
import { useShellEvidence } from './shell-evidence';

/** Route adapter; calendar, draft state and comparison controls live in packages/ui. */
export function DateRangePicker({ path, trigger, period, today, comparison, includeToday = false, selectedPresetId, preserved = {} }: {
  path: string;
  trigger?: ReactNode;
  period: Period;
  today: string;
  comparison?: Period;
  includeToday?: boolean;
  selectedPresetId?: string;
  preserved?: Readonly<Record<string, string | undefined>>;
}): ReactNode {
  const router = useRouter();
  const evidence = useShellEvidence();
  const mode = preserved['comparison'] === 'none' ? 'none' : preserved['comparison'] === 'year' ? 'year'
    : comparison !== undefined || preserved['compareFrom'] ? 'custom' : 'previous';
  const custom = comparison ?? (preserved['compareFrom'] && preserved['compareTo']
    ? { start: preserved['compareFrom'], end: preserved['compareTo'] }
    : comparisonRange(period, 'previous', period)!);
  return <SharedDateRangePicker period={period} comparison={custom} today={today} includeToday={includeToday} mode={mode}
    hiddenFields={Object.fromEntries(Object.entries(preserved).filter(([name]) => !['from', 'to', 'preset'].includes(name)))}
    trigger={trigger} {...(selectedPresetId === undefined ? {} : { selectedPresetId })}
    factsThrough={evidence?.freshness?.coversThrough ?? null} factsComplete={evidence?.freshness?.tone === 'good'}
    presetHref={(range, preset) => dateRangeHref(path, range, { ...preserved, preset })}
    onApply={(selection) => router.push(dateRangeHref(path, selection.period, { ...preserved,
      preset: selection.preset, comparison: selection.mode,
      compareFrom: selection.mode === 'previous' ? undefined : selection.comparison?.start,
      compareTo: selection.mode === 'previous' ? undefined : selection.comparison?.end,
    }))} />;
}
