import { describe, expect, it } from 'vitest';
import {
  MATCH_TYPE_LABELS,
  MatchType,
  PLACEMENT_LABELS,
  Placement,
  TARGET_EXPRESSION_LABELS,
  TARGET_EXPRESSION_TYPES,
} from '@wizard-ads/shared';
import type { GridRow } from './rows.js';
import { columnsFor } from './columns.js';
import { toCsv } from './csv.js';
import { filterSetOf } from './filter.js';
import { syntheticSearchTermRows } from './fixtures.js';
import { buildGridModel } from './pipeline.js';

const columns = columnsFor('search_terms').filter((column) =>
  ['search_term', 'spend', 'sales', 'acos', 'acos_delta_percent'].includes(column.id),
);
const nestedColumns = columnsFor('search_terms').filter((column) =>
  ['campaign_name', 'ad_group_name', 'match_type', 'spend', 'sales', 'acos'].includes(column.id),
);

describe('toCsv', () => {
  it('exports the filtered set, and counts it against the unfiltered one', () => {
    const rows = syntheticSearchTermRows(2000, { seed: 9 });
    const model = buildGridModel(rows, {
      filter: filterSetOf({ key: 'CLICKS', conditions: [{ operator: '>=', values: ['10'] }] }),
    });

    const result = toCsv(model, { columns, label: 'Search terms', currencyCode: 'USD' });

    expect(result.exported).toBe(model.shown);
    expect(result.total).toBe(2000);
    expect(result.exported).toBeLessThan(result.total);
    // Provenance line + header + one line per row.
    expect(result.csv.trimEnd().split('\n')).toHaveLength(result.exported + 2);
  });

  it('exports raw values, not formatted ones, so a spreadsheet can sum a column', () => {
    const rows = syntheticSearchTermRows(5, { seed: 1 });
    const model = buildGridModel(rows);
    const csv = toCsv(model, { columns, label: 'Search terms', currencyCode: 'EUR' }).csv;
    const dataLines = csv.trimEnd().split('\n').slice(2);

    expect(csv).not.toContain('€');
    // The header row carries "ACOS Δ%" as a label; no *value* is percent-formatted.
    expect(dataLines.join('\n')).not.toContain('%');
    const firstDataLine = csv.split('\n')[2] as string;
    const acos = firstDataLine.split(',')[3];
    // A fraction, not "24.3%": the value the pipeline holds, unchanged.
    expect(Number(acos)).toBeLessThan(10);
  });

  it('states the period, the currency and the counts on the first line', () => {
    const model = buildGridModel(syntheticSearchTermRows(3, { seed: 2 }));
    const result = toCsv(model, {
      columns,
      label: 'Search terms',
      currencyCode: 'JPY',
      period: { start: '2026-07-01', end: '2026-07-31' },
      comparisonPeriod: { start: '2026-06-01', end: '2026-06-30' },
    });
    const header = result.csv.split('\n')[0] as string;
    expect(header).toContain('2026-07-01..2026-07-31');
    expect(header).toContain('2026-06-01..2026-06-30');
    expect(header).toContain('currency JPY');
    expect(header).toContain('3 of 3 source rows');
  });

  it('says so when the export is of grouped rows', () => {
    const model = buildGridModel(syntheticSearchTermRows(500, { seed: 4 }), {
      groupBy: ['campaign_name'],
    });
    const result = toCsv(model, { columns, label: 'Search terms', currencyCode: 'USD' });
    expect(result.csv.split('\n')[0]).toContain('recomputed from summed bases');
    expect(result.exported).toBe(model.shown);
    expect(result.total).toBe(500);
  });

  it('exports deepest nested groups only, so parent summaries cannot double-count totals', () => {
    const rows = syntheticSearchTermRows(3_597, { seed: 41 });
    const model = buildGridModel(rows, {
      groupBy: ['campaign_name', 'ad_group_name', 'match_type'],
    });
    const result = toCsv(model, {
      columns: nestedColumns,
      label: 'Search terms',
      currencyCode: 'USD',
    });
    const lines = result.csv.trimEnd().split('\n');
    const provenance = lines[0] as string;
    const headers = (lines[1] as string).split(',');
    const spendIndex = headers.indexOf('Spend');
    const exportedSpend = lines
      .slice(2)
      .reduce((sum, line) => sum + Number(line.split(',')[spendIndex]), 0);

    expect(model.exported).toBeLessThan(model.shown);
    expect(result.exported).toBe(model.exported);
    expect(lines).toHaveLength(model.exported + 2);
    expect(provenance).toContain('deepest groups');
    expect(provenance).toContain('parent summaries omitted');
    expect(provenance).toContain('campaign_name > ad_group_name > match_type');
    expect(exportedSpend).toBeCloseTo(model.totalsRow?.totals.spend ?? -1, 6);
  });

  it('escapes quotes, commas and newlines', () => {
    const model = buildGridModel([
      {
        id: 'x',
        dimensions: { search_term: 'say "hi", then\nleave' },
        totals: { impressions: 1, clicks: 1, spend: 1, sales: 1, orders: 1, units: 1 },
        comparison: null,
        currencyCode: 'USD',
      },
    ]);
    const csv = toCsv(model, { columns, label: 'x', currencyCode: 'USD' }).csv;
    expect(csv).toContain('"say ""hi"", then\nleave"');
  });

  it('names the file after the view and the day', () => {
    const model = buildGridModel(syntheticSearchTermRows(1, { seed: 1 }));
    const result = toCsv(model, { columns, label: 'Search terms', currencyCode: 'USD' });
    expect(result.filename).toMatch(/^openspell-search-terms-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});

/** Split CSV data lines into cells, honouring quoted cells. */
function cells(csv: string): string[][] {
  return csv.trimEnd().split('\n').slice(2).map((line) => {
    const out: string[] = [];
    let cell = '';
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index]!;
      if (quoted && char === '"' && line[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = !quoted;
      else if (char === ',' && !quoted) { out.push(cell); cell = ''; }
      else cell += char;
    }
    out.push(cell);
    return out;
  });
}

/** Snake-case and Amazon upper-case codes, as the grid readability test defines them. */
const CODE_SHAPE = /\b(?:[a-z]+_[a-z_]+|[A-Z]+_[A-Z_]+)\b/;
const zero = { impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0, units: 0 };
const gridRow = (id: string, dimensions: GridRow['dimensions']): GridRow =>
  ({ id, currencyCode: 'USD', dimensions, totals: { ...zero, spend: 10 }, comparison: null });

describe('toCsv vocabulary labels', () => {
  it('writes targeting, kind and match type as the grid words, with the target id raw in its own column', () => {
    const targets = columnsFor('targets');
    const picked = ['targeting', 'target_kind', 'match_type', 'target_id', 'spend'].map((id) => targets.find((column) => column.id === id)!);
    const rows = [
      ...MatchType.options.map((matchType, index) => gridRow(`match-${index}`, { targeting: `synthetic phrase ${index}`, target_kind: 'keyword', match_type: matchType, target_id: `tid_match_${index}` })),
      ...TARGET_EXPRESSION_TYPES.map((type, index) => gridRow(`expression-${index}`, { targeting: index % 2 ? type : `${type}="B000SYN${String(index).padStart(3, '0')}"`, target_kind: 'target', match_type: null, target_id: `tid_expression_${index}` })),
    ];
    const result = toCsv(buildGridModel(rows), { columns: picked, label: 'Targets', currencyCode: 'USD' });
    const data = cells(result.csv);
    expect(result.exported).toBe(rows.length);
    expect(data).toHaveLength(rows.length);
    MatchType.options.forEach((matchType, index) => {
      expect(data[index]![2], matchType).toBe(MATCH_TYPE_LABELS[matchType]);
      expect(data[index]![0]).toBe(`synthetic phrase ${index}`);
      expect(data[index]![1]).toBe('Keyword');
      expect(data[index]![3]).toBe(`tid_match_${index}`);
    });
    TARGET_EXPRESSION_TYPES.forEach((type, index) => {
      const row = data[MatchType.options.length + index]!;
      expect(row[0], type).toContain(TARGET_EXPRESSION_LABELS[type]);
      expect(row[0], type).not.toContain(type);
      expect(row[2], type).toBe('');
      expect(row[3]).toBe(`tid_expression_${index}`);
    });
    expect(new Set(data.map((row) => row[1]))).toEqual(new Set(['Keyword', 'Automatic target', 'Product target', 'Theme target', 'Audience target']));
    // Only the id column may keep a code shape.
    for (const row of data) for (const cell of [row[0]!, row[1]!, row[2]!]) expect(cell).not.toMatch(CODE_SHAPE);
  });

  it('writes placements as words and keeps the campaign id raw', () => {
    const placements = columnsFor('placements');
    const picked = ['placement', 'campaign_id', 'spend'].map((id) => placements.find((column) => column.id === id)!);
    expect(picked.every((column) => column !== undefined)).toBe(true);
    const rows = Placement.options.map((placement, index) => gridRow(`placement-${index}`, { placement, campaign_id: `cid_${index}` }));
    const data = cells(toCsv(buildGridModel(rows), { columns: picked, label: 'Placements', currencyCode: 'USD' }).csv);
    expect(data.map((row) => row[0])).toEqual(Placement.options.map((placement) => PLACEMENT_LABELS[placement]));
    expect(data.map((row) => row[1])).toEqual(Placement.options.map((_, index) => `cid_${index}`));
  });
});
