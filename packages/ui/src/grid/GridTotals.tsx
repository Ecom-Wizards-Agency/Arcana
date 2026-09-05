'use client';

/**
 * The totals row, stuck directly beneath the header.
 *
 * Its first cell names the population the totals describe -- source rows when
 * grouped, shown rows otherwise -- so an operator reading a grouped total is
 * never left guessing whether hierarchy rows were counted. Every other cell is
 * the totals row through `GridCell`, so ratios come out of `metrics.ts` and are
 * recomputed from summed bases here as everywhere.
 */
import type { ReactNode } from 'react';
import type { Column } from '@tanstack/react-table';
import type { GroupedRow } from '../aggregate.js';
import type { GridColumn } from '../columns.js';
import { formatInteger } from '../format.js';
import type { GridModel } from '../pipeline.js';
import type { GridRow } from '../rows.js';
import { GridCell } from './GridCell.js';
import type { GridCellEnvironment } from './GridCell.js';
import { totalsCellStyle, totalsRow } from './styles.js';

export interface GridTotalsProps {
  leafColumns: readonly Column<GridRow, unknown>[];
  columns: readonly GridColumn[];
  model: GridModel;
  row: GroupedRow;
  locale: string | undefined;
  environment: GridCellEnvironment;
}

export function GridTotals({
  leafColumns,
  columns,
  model,
  row,
  locale,
  environment,
}: GridTotalsProps): ReactNode {
  return (
    <div style={totalsRow} role="row">
      {leafColumns.map((column) => {
        const definition = columns.find((candidate) => candidate.id === column.id);
        const isPinned = column.getIsPinned() === 'left';
        const isFirst = column === leafColumns[0];
        return (
          <div
            key={column.id}
            role="cell"
            style={totalsCellStyle(
              column.getSize(),
              definition,
              isPinned ? { left: column.getStart('left') } : null,
            )}
          >
            {isFirst ? (
              model.grouped
                ? `Total · ${formatInteger(model.matched, locale)} source row${model.matched === 1 ? '' : 's'}`
                : `Total · ${formatInteger(model.shown, locale)} row${model.shown === 1 ? '' : 's'}`
            ) : definition === undefined ? null : (
              <GridCell row={row} column={definition} {...environment} />
            )}
          </div>
        );
      })}
    </div>
  );
}
