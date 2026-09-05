/**
 * Grouping-level edits and the drag payloads that drive them. Pure; no React.
 *
 * The group bar is a direct-manipulation surface: drag a column header onto it
 * to group, drop a second header to nest, drag a chip to reorder. Every one of
 * those gestures reduces to an ordered list edit, and those edits live here so
 * the bar, the keyboard path (the select and the move buttons) and the tests
 * all produce the same list for the same intent.
 *
 * Drag payloads travel through `DataTransfer` under private MIME types rather
 * than through component state, because the source (a grid header) and the
 * target (the toolbar's group bar) are different components with no shared
 * parent below the page. Browsers hide `getData` during `dragover`, so a drop
 * target decides whether to accept from `types` alone and reads the id on drop.
 */

export const COLUMN_DRAG_TYPE = 'application/x-wizard-ads-column';
export const GROUP_LEVEL_DRAG_TYPE = 'application/x-wizard-ads-group-level';

/** The subset of `DataTransfer` these helpers touch, so tests can hand in a literal. */
export interface DragPayloadCarrier {
  readonly types: readonly string[];
  getData(format: string): string;
  setData(format: string, data: string): void;
  effectAllowed?: string;
  dropEffect?: string;
}

export function writeDragPayload(
  carrier: DragPayloadCarrier | null | undefined,
  type: string,
  id: string,
): void {
  if (carrier === null || carrier === undefined) return;
  carrier.setData(type, id);
  // A text fallback keeps the drag visible to anything that inspects it, and
  // makes a drop outside the app paste the column id rather than nothing.
  carrier.setData('text/plain', id);
  try {
    carrier.effectAllowed = 'move';
  } catch {
    // Read-only in some drag phases; the payload is what matters.
  }
}

export function hasDragPayload(carrier: DragPayloadCarrier | null | undefined, type: string): boolean {
  if (carrier === null || carrier === undefined) return false;
  return Array.from(carrier.types).includes(type);
}

export function readDragPayload(carrier: DragPayloadCarrier | null | undefined, type: string): string | null {
  if (carrier === null || carrier === undefined) return null;
  const value = carrier.getData(type);
  return value === '' ? null : value;
}

/**
 * Insert `columnId` before `beforeId` (or at the end when `beforeId` is null).
 * A level already present moves rather than duplicating; nesting the same
 * dimension twice is meaningless and the pipeline would collapse it anyway.
 */
export function insertGroupLevel(
  groupBy: readonly string[],
  columnId: string,
  beforeId: string | null = null,
): string[] {
  const remaining = groupBy.filter((id) => id !== columnId);
  if (beforeId === null || beforeId === columnId) return [...remaining, columnId];
  const at = remaining.indexOf(beforeId);
  if (at < 0) return [...remaining, columnId];
  remaining.splice(at, 0, columnId);
  return remaining;
}

export function removeGroupLevel(groupBy: readonly string[], columnId: string): string[] {
  return groupBy.filter((id) => id !== columnId);
}

/** Swap a level with its neighbour. Out-of-range moves return the input unchanged. */
export function shiftGroupLevel(
  groupBy: readonly string[],
  index: number,
  delta: -1 | 1,
): string[] {
  const target = index + delta;
  if (index < 0 || index >= groupBy.length || target < 0 || target >= groupBy.length) {
    return [...groupBy];
  }
  const next = [...groupBy];
  const current = next[index];
  const displaced = next[target];
  if (current === undefined || displaced === undefined) return next;
  next[index] = displaced;
  next[target] = current;
  return next;
}
