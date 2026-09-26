'use client';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { describeTargeting, targetKindLabel } from '@wizard-ads/shared';
import { DataGrid, displayValue, formatInteger, formatValue, resolveField, tokens, type GridColumn, type GridRow } from '@wizard-ads/ui';
import { TargetDrawerTrigger } from '../targets/drawer-trigger';

const text = (value: unknown): string | null => typeof value === 'string' && value.trim() !== '' ? value : null;

/**
 * The Target cell of the targets grid (V19, D3, D6). The link reads what is
 * targeted in words: a keyword's text, or an expression such as "Close match" or
 * "Product: B0…" where Amazon's code used to show. The line beneath names the
 * match type of a keyword, or the kind of an expression target, the campaign's
 * purpose, and the caveat for a target that matches many searches. Every word
 * comes from the shared targeting labels, so the Match and Kind columns, filter
 * chips and Target 360 say the same thing.
 */
export function TargetingCell({ row, href }: { row: GridRow; href: string }): ReactNode {
  const targetId = String(row.dimensions['target_id'] ?? '');
  const kind = text(row.dimensions['target_kind']);
  const raw = text(row.dimensions['targeting']);
  const described = describeTargeting({ targeting: raw ?? targetId, targetKind: kind, matchType: text(row.dimensions['match_type']) });
  const label = described.label === '' ? targetId : described.label;
  const detail = described.group === 'keyword' ? described.type : targetKindLabel(kind, raw);
  const purpose = text(row.dimensions['campaign_purpose']);
  return <span data-targeting-cell style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
    <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.space(1), minWidth: 0 }}>
      <Link href={href} prefetch={false} title={label} onClick={(event) => event.stopPropagation()} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</Link>
      <TargetDrawerTrigger label={label} targetId={targetId} />
    </span>
    <small style={{ color: tokens.color.textMuted, display: 'flex', alignItems: 'center', gap: tokens.space(1), minWidth: 0 }}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{[detail, purpose].filter((part): part is string => part !== null).join(' · ')}</span>
      {row.dimensions['not_the_query'] === true ? <DataGrid.cells.NotTheQueryChip /> : null}
    </small>
  </span>;
}

/** The select-all header of the selection column, with a mixed state for a partial selection (J4). */
export function SelectAllMatched({ rowIds, selected, onChange }: {
  rowIds: readonly string[];
  selected: ReadonlySet<string>;
  onChange: (next: (current: string[]) => string[]) => void;
}): ReactNode {
  const state = DataGrid.cells.selectionState(rowIds, selected);
  return <DataGrid.cells.SelectAllCheckbox
    state={state}
    count={rowIds.length}
    label={`Select all ${formatInteger(rowIds.length)} matching ${rowIds.length === 1 ? 'row' : 'rows'}`}
    onChange={(select) => {
      const matched = new Set(rowIds);
      onChange((current) => select ? [...new Set([...current, ...rowIds])] : current.filter((id) => !matched.has(id)));
    }}
  />;
}

/**
 * A row's selection checkbox, named by what the row is in words ("Select Top of
 * search in Synthetic campaign") rather than its internal id, which carried the
 * stored placement and target codes into the accessible name.
 */
export function SelectRowCheckbox({ row, identity, checked, onToggle }: {
  row: GridRow;
  identity: GridColumn | undefined;
  checked: boolean;
  onToggle: () => void;
}): ReactNode {
  const shown = identity === undefined ? null : displayValue(identity, resolveField(row, identity.id), row);
  const name = shown === null || shown === '' ? row.id : formatValue(shown, 'text', { currencyCode: row.currencyCode });
  const campaign = identity?.id === 'campaign_name' ? null : text(row.dimensions['campaign_name']);
  return <input type="checkbox" aria-label={`Select ${name}${campaign === null ? '' : ` in ${campaign}`}`} checked={checked}
    onClick={(event) => event.stopPropagation()} onChange={onToggle} />;
}
