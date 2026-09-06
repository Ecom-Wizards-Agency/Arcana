import { describe, expect, it } from 'vitest';
import {
  COLUMN_DRAG_TYPE,
  GROUP_LEVEL_DRAG_TYPE,
  hasDragPayload,
  insertGroupLevel,
  readDragPayload,
  removeGroupLevel,
  shiftGroupLevel,
  writeDragPayload,
} from './grouping.js';
import type { DragPayloadCarrier } from './grouping.js';

function carrier(): DragPayloadCarrier & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get types() {
      return [...data.keys()];
    },
    getData: (format) => data.get(format) ?? '',
    setData: (format, value) => {
      data.set(format, value);
    },
  };
}

describe('group level edits', () => {
  it('appends a new level at the end and nests before a named level', () => {
    expect(insertGroupLevel([], 'search_term')).toEqual(['search_term']);
    expect(insertGroupLevel(['search_term'], 'targeting')).toEqual(['search_term', 'targeting']);
    expect(insertGroupLevel(['search_term', 'match_type'], 'targeting', 'match_type')).toEqual([
      'search_term',
      'targeting',
      'match_type',
    ]);
  });

  it('moves a level that is already present instead of duplicating it', () => {
    expect(insertGroupLevel(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
    expect(insertGroupLevel(['a', 'b', 'c'], 'a')).toEqual(['b', 'c', 'a']);
    expect(insertGroupLevel(['a', 'b'], 'a', 'a')).toEqual(['b', 'a']);
  });

  it('appends when the anchor level is unknown, and never mutates its input', () => {
    const input = ['a', 'b'];
    expect(insertGroupLevel(input, 'c', 'zzz')).toEqual(['a', 'b', 'c']);
    expect(input).toEqual(['a', 'b']);
  });

  it('removes a level and shifts neighbours without leaving the list', () => {
    expect(removeGroupLevel(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
    expect(shiftGroupLevel(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(shiftGroupLevel(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(shiftGroupLevel(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  });
});

describe('drag payloads', () => {
  it('round-trips a column id under its own MIME type with a text fallback', () => {
    const transfer = carrier();
    writeDragPayload(transfer, COLUMN_DRAG_TYPE, 'campaign_name');
    expect(hasDragPayload(transfer, COLUMN_DRAG_TYPE)).toBe(true);
    expect(hasDragPayload(transfer, GROUP_LEVEL_DRAG_TYPE)).toBe(false);
    expect(readDragPayload(transfer, COLUMN_DRAG_TYPE)).toBe('campaign_name');
    expect(transfer.getData('text/plain')).toBe('campaign_name');
    expect(transfer.effectAllowed).toBe('move');
  });

  it('treats a missing transfer or an absent type as no payload', () => {
    expect(hasDragPayload(null, COLUMN_DRAG_TYPE)).toBe(false);
    expect(readDragPayload(undefined, COLUMN_DRAG_TYPE)).toBeNull();
    expect(readDragPayload(carrier(), COLUMN_DRAG_TYPE)).toBeNull();
  });
});
