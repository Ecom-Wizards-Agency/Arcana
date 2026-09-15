'use client';

/**
 * One cell.
 *
 * A control column is empty here by construction; its host supplies the
 * checkbox or action through `DataGrid`'s `renderCell`, and only for source
 * rows. Otherwise four shapes, in precedence order: a group-header cell (the collapse toggle,
 * the branch marker and the row count), a suggested-bid median over its range,
 * a delta coloured by the metric's `better` direction, and the plain formatted
 * value. The same component renders the totals row and the aggregate beneath a
 * sorted header, so a total and a body cell can never format differently.
 */
import type { ReactNode } from 'react';
import { type GroupedRow, isGroupedRow } from '../aggregate.js';
import type { GridColumn } from '../columns.js';
import { formatDelta, formatInteger, formatValue } from '../format.js';
import type { FormatContext } from '../format.js';
import { metricSpec } from '../metrics.js';
import type { GridRow } from '../rows.js';
import { parseFieldId, resolveField } from '../rows.js';
import { NumericValue } from '../primitives/NumericValue.js';
import { tokens } from '../theme.js';
import { StatusChip } from '../primitives/StatusChip.js';
import { deltaColor } from '../theme.js';
import {
  cellSubline,
  deltaStyle,
  groupBranch,
  groupCell,
  groupCount,
  groupLeafMarker,
  groupToggle,
  groupValue,
  twoLineCell,
} from './styles.js';

/** What every cell needs beyond its own row and column. */
export interface GridCellEnvironment {
  context: FormatContext;
  totalsRow?: GroupedRow | null;
  collapsedGroupIds: ReadonlySet<string>;
  onToggleGroup: (groupId: string) => void;
}

export interface GridCellProps extends GridCellEnvironment {
  row: GridRow;
  column: GridColumn;
}

export function GridCell({ row, column, context, totalsRow, collapsedGroupIds, onToggleGroup }: GridCellProps): ReactNode {
  // A control column has no value anywhere: not on a source row, not on a
  // group, not in the totals. Formatting its absent field would print `—` in
  // the totals row under a checkbox, which reads as a figure that failed.
  if (column.kind === 'control') return null;

  const value = resolveField(row, column.id);
  const ref = parseFieldId(column.id);

  if (isGroupedRow(row) && row.groupDepth >= 0 && column.kind === 'dimension') {
    if (row.groupColumnId !== column.id) return value == null ? null : <span>{formatValue(value, column.scale, context)}<sup style={groupCount}>{formatInteger(row.groupSize, context.locale)}</sup></span>;
    const collapsed = collapsedGroupIds.has(row.id);
    return (
      <span data-testid={`group-level-${row.groupDepth + 1}`} style={groupCell}>
        {row.isLeafGroup ? (
          <span aria-hidden style={groupLeafMarker}>•</span>
        ) : (
          <button
            type="button"
            aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${column.header} ${formatValue(value, column.scale, context)}`}
            aria-expanded={!collapsed}
            onClick={(event) => {
              event.stopPropagation();
              onToggleGroup(row.id);
            }}
            style={groupToggle}
          >
            <span aria-hidden>{collapsed ? '▸' : '▾'}</span>
          </button>
        )}
        {row.groupDepth === 0 ? null : <span aria-hidden style={groupBranch}>↳</span>}
        <span style={groupValue}>{formatValue(value, column.scale, context)}</span>
        <sup style={groupCount}>{formatInteger(row.groupSize, context.locale)} rows</sup>
        {totalsRow && resolveField(row, 'spend') !== null && typeof resolveField(totalsRow, 'spend') === 'number' && totalsRow.totals.spend > 0 ? <span data-share-bar role="meter" aria-label="Share of total spend" aria-valuemin={0} aria-valuemax={100} aria-valuenow={row.totals.spend / totalsRow.totals.spend * 100} title={`${formatValue(row.totals.spend / totalsRow.totals.spend, 'percent', context)} of total spend`} style={{ display: 'inline-block', flexShrink: 0, width: tokens.space(8), height: tokens.space(1), background: tokens.color.surfaceHover }}><span style={{ display: 'block', height: '100%', width: `${Math.min(1, row.totals.spend / totalsRow.totals.spend) * 100}%`, background: tokens.color.indigo }} /></span> : null}
      </span>
    );
  }

  if (column.cell === 'status') {
    return value === 'working' || value === 'needs-data' || value === 'idea'
      ? <StatusChip status={value} /> : <>{formatValue(value, column.scale, context)}</>;
  }

  if (column.cell === 'suggested_bid') {
    const low = resolveField(row, 'suggested_bid_low');
    const high = resolveField(row, 'suggested_bid_high');
    return (
      <span data-testid="suggested-bid-cell" style={{ ...twoLineCell, minWidth: 0, width: '100%' }}
        title={`${formatValue(value, column.scale, context)} · ${formatValue(low, column.scale, context)} – ${formatValue(high, column.scale, context)}`}>
        <NumericValue value={formatValue(value, column.scale, context)} />
        {value === null ? null : (
          <span style={cellSubline}>
            {formatValue(low, column.scale, context)} – {formatValue(high, column.scale, context)}
          </span>
        )}
      </span>
    );
  }

  if (ref !== null && (ref.part === 'delta_absolute' || ref.part === 'delta_percent')) {
    const spec = metricSpec(ref.metric);
    const numeric = typeof value === 'number' ? value : null;
    return (
      <NumericValue value={formatDelta(numeric, column.scale, context)} style={deltaStyle(deltaColor(numeric, spec?.better ?? null))} />
    );
  }

  const formatted = formatValue(value, column.scale, context);
  const denominator = totalsRow == null ? null : resolveField(totalsRow, column.id);
  const share = isGroupedRow(row) && row.groupDepth >= 0 && (ref?.part === 'value' || ref?.part === 'comparison')
    && metricSpec(ref.metric)?.derived === null && typeof value === 'number'
    && typeof denominator === 'number' && denominator > 0 ? value / denominator : null;
  return <span style={{ display: 'block', minWidth: 0, width: '100%' }}>
    {column.scale !== 'text' || column.cell === 'numeric' ? <NumericValue value={formatted} /> : formatted}
    {share === null ? null : <span style={{ ...cellSubline, marginLeft: '0.375rem' }}>
      <span data-share-bar role="meter" aria-label="Share of total" aria-valuenow={share * 100} aria-valuemin={0} aria-valuemax={100} style={{ display: 'inline-block', width: tokens.space(12), height: tokens.space(1), background: tokens.color.surfaceHover }}><span style={{ display: 'block', width: `${Math.min(1, share) * 100}%`, height: '100%', background: tokens.color.indigo }} /></span>{formatValue(share, 'percent', context)} of total
    </span>}
  </span>;
}
