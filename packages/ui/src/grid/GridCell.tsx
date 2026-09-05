'use client';

/**
 * One cell.
 *
 * Four shapes, in precedence order: a group-header cell (the collapse toggle,
 * the branch marker and the row count), a suggested-bid median over its range,
 * a delta coloured by the metric's `better` direction, and the plain formatted
 * value. The same component renders the totals row and the aggregate beneath a
 * sorted header, so a total and a body cell can never format differently.
 */
import type { ReactNode } from 'react';
import { isGroupedRow } from '../aggregate.js';
import type { GridColumn } from '../columns.js';
import { formatDelta, formatInteger, formatValue } from '../format.js';
import type { FormatContext } from '../format.js';
import { metricSpec } from '../metrics.js';
import type { GridRow } from '../rows.js';
import { parseFieldId, resolveField } from '../rows.js';
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
  collapsedGroupIds: ReadonlySet<string>;
  onToggleGroup: (groupId: string) => void;
}

export interface GridCellProps extends GridCellEnvironment {
  row: GridRow;
  column: GridColumn;
}

export function GridCell({ row, column, context, collapsedGroupIds, onToggleGroup }: GridCellProps): ReactNode {
  const value = resolveField(row, column.id);
  const ref = parseFieldId(column.id);

  if (isGroupedRow(row) && row.groupDepth >= 0 && column.kind === 'dimension') {
    if (row.groupColumnId !== column.id) return null;
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
        <span style={groupCount}>{formatInteger(row.groupSize, context.locale)} rows</span>
      </span>
    );
  }

  if (column.cell === 'suggested_bid') {
    const low = resolveField(row, 'suggested_bid_low');
    const high = resolveField(row, 'suggested_bid_high');
    return (
      <span data-testid="suggested-bid-cell" style={twoLineCell}>
        <span>{formatValue(value, column.scale, context)}</span>
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
      <span style={deltaStyle(deltaColor(numeric, spec?.better ?? null))}>
        {formatDelta(numeric, column.scale, context)}
      </span>
    );
  }

  return <>{formatValue(value, column.scale, context)}</>;
}
