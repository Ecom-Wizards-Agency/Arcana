import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  formatSqpRefusalSummary,
  parseSqpReport,
  SQP_PARSER_VERSION,
  summarizeSqpRefusals,
} from './sqp.js';

const PROFILE_ID = '00000000-0000-4000-8000-000000000001';
const WEEK = { expectedWeekStart: '2026-08-16', expectedWeekEnd: '2026-08-22' } as const;
const SCHEMA_TEXT = readFileSync(new URL('./sqp-report.schema.json', import.meta.url), 'utf8');
const SCHEMA = JSON.parse(SCHEMA_TEXT) as Record<string, unknown>;

type Funnel = { total: number; asin: number; share: number };

interface RowInput {
  asin?: string;
  searchQuery?: string;
  impression?: Funnel;
  click?: Funnel;
  cartAdd?: Funnel;
  purchase?: Funnel;
}

function money(amount: number) {
  return { amount, currencyCode: 'USD' };
}

/** A synthetic row carrying every field the published schema requires, including ignored ones. */
function reportRow(input: RowInput = {}): Record<string, unknown> {
  const impression = input.impression ?? { total: 80, asin: 8, share: 0.1 };
  const click = input.click ?? { total: 20, asin: 4, share: 0.2 };
  const cartAdd = input.cartAdd ?? { total: 10, asin: 2, share: 0.2 };
  const purchase = input.purchase ?? { total: 5, asin: 2, share: 0.4 };
  return {
    startDate: '2026-08-16',
    endDate: '2026-08-22',
    asin: input.asin ?? 'B000000001',
    searchQueryData: {
      searchQuery: input.searchQuery ?? 'Synthetic Query',
      searchQueryScore: 3,
      searchQueryVolume: 120,
    },
    impressionData: {
      totalQueryImpressionCount: impression.total,
      asinImpressionCount: impression.asin,
      asinImpressionShare: impression.share,
    },
    clickData: {
      totalClickCount: click.total,
      totalClickRate: 0.1,
      asinClickCount: click.asin,
      asinClickShare: click.share,
      totalMedianClickPrice: money(11.5),
      asinMedianClickPrice: money(12.5),
      totalSameDayShippingClickCount: 1,
      totalOneDayShippingClickCount: 2,
      totalTwoDayShippingClickCount: 3,
    },
    cartAddData: {
      totalCartAddCount: cartAdd.total,
      totalCartAddRate: 0.05,
      asinCartAddCount: cartAdd.asin,
      asinCartAddShare: cartAdd.share,
      totalMedianCartAddPrice: money(11.5),
      asinMedianCartAddPrice: money(12.5),
      totalSameDayShippingCartAddCount: 0,
      totalOneDayShippingCartAddCount: 1,
      totalTwoDayShippingCartAddCount: 1,
    },
    purchaseData: {
      totalPurchaseCount: purchase.total,
      totalPurchaseRate: 0.02,
      asinPurchaseCount: purchase.asin,
      asinPurchaseShare: purchase.share,
      totalMedianPurchasePrice: money(11.5),
      asinMedianPurchasePrice: money(12.5),
      totalSameDayShippingPurchaseCount: 0,
      totalOneDayShippingPurchaseCount: 0,
      totalTwoDayShippingPurchaseCount: 1,
    },
  };
}

function reportDocument(rows: unknown[]): Record<string, unknown> {
  return {
    reportSpecification: {
      reportType: 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT',
      reportOptions: { reportPeriod: 'WEEK', asin: 'B000000001 B000000002' },
      dataStartTime: '2026-08-16',
      dataEndTime: '2026-08-22',
      marketplaceIds: ['marketplace-1'],
    },
    dataByAsin: rows,
  };
}

/** Percentage shares as Brand Analytics shows them: 12.34 %, 100 % and 0 %. */
function percentageRow(): Record<string, unknown> {
  return reportRow({
    asin: 'B000000002',
    searchQuery: 'Synthetic Percentage Query',
    impression: { total: 10_000, asin: 1_234, share: 12.34 },
    click: { total: 5, asin: 5, share: 100 },
    cartAdd: { total: 3, asin: 0, share: 0 },
    purchase: { total: 0, asin: 0, share: 0 },
  });
}

/**
 * The JSON Schema draft-07 subset the vendored schema uses. An unsupported
 * keyword throws, so the validator cannot silently skip a constraint.
 */
const SUPPORTED_KEYWORDS = new Set([
  '$schema', '$comment', 'description', 'examples', 'definitions',
  'type', 'required', 'properties', 'items', '$ref', 'enum', 'format', 'pattern',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validate(schema: Record<string, unknown>, value: unknown, path = '$'): string[] {
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) throw new Error(`unsupported schema keyword ${keyword}`);
  }
  const ref = schema['$ref'];
  if (typeof ref === 'string') {
    const name = /^#\/definitions\/([A-Za-z]+)$/.exec(ref)?.[1];
    const definitions = SCHEMA['definitions'];
    const target = name !== undefined && isObject(definitions) ? definitions[name] : undefined;
    if (!isObject(target)) throw new Error(`unresolved schema reference ${ref}`);
    return validate(target, value, path);
  }
  const errors: string[] = [];
  switch (schema['type']) {
    case undefined: break;
    case 'object': if (!isObject(value)) return [`${path} is not an object`]; break;
    case 'array': if (!Array.isArray(value)) return [`${path} is not an array`]; break;
    case 'string': if (typeof value !== 'string') return [`${path} is not a string`]; break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return [`${path} is not a number`];
      break;
    case 'integer': if (!Number.isInteger(value)) return [`${path} is not an integer`]; break;
    default: throw new Error(`unsupported schema type at ${path}`);
  }
  if (Array.isArray(schema['enum']) && !schema['enum'].includes(value)) errors.push(`${path} is outside its enum`);
  if (schema['format'] === 'date') {
    const text = String(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) !== text) {
      errors.push(`${path} is not a date`);
    }
  } else if (schema['format'] !== undefined) {
    throw new Error(`unsupported schema format at ${path}`);
  }
  if (typeof schema['pattern'] === 'string' && !new RegExp(schema['pattern'], 'u').test(String(value))) {
    errors.push(`${path} does not match its pattern`);
  }
  if (isObject(value)) {
    for (const key of Array.isArray(schema['required']) ? schema['required'] : []) {
      if (!Object.hasOwn(value, String(key))) errors.push(`${path}.${String(key)} is required`);
    }
    const properties = isObject(schema['properties']) ? schema['properties'] : {};
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key) && isObject(child)) errors.push(...validate(child, value[key], `${path}.${key}`));
    }
  }
  if (Array.isArray(value) && isObject(schema['items'])) {
    const items = schema['items'];
    value.forEach((element, index) => errors.push(...validate(items, element, `${path}[${index}]`)));
  }
  return errors;
}

describe('vendored SQP report schema', () => {
  it('matches the upstream bytes named in its origin note', () => {
    const lines = SCHEMA_TEXT.split('\n');
    const comment = String(SCHEMA['$comment']);
    const recorded = /SHA-256 of the upstream bytes ([a-f0-9]{64})/.exec(comment)?.[1];
    expect(lines[1]).toMatch(/^ {2}"\$comment": /);
    const upstream = [lines[0], ...lines.slice(2)].join('\n').replace(/\n$/, '');
    expect(recorded).toBeDefined();
    expect(createHash('sha256').update(upstream).digest('hex')).toBe(recorded);
  });

  it('accepts the synthetic fixture document, fraction and percentage rows alike', () => {
    const document = reportDocument([reportRow(), percentageRow()]);
    expect(validate(SCHEMA, document)).toEqual([]);
    expect((document['dataByAsin'] as unknown[]).length).toBe(2);
  });

  it('is not vacuous: it rejects a row missing an ignored field and a string share', () => {
    const missingRate = reportRow();
    delete (missingRate['clickData'] as Record<string, unknown>)['totalClickRate'];
    const stringShare = reportRow();
    (stringShare['impressionData'] as Record<string, unknown>)['asinImpressionShare'] = '10';
    expect(validate(SCHEMA, reportDocument([missingRate, stringShare]))).toEqual([
      '$.dataByAsin[0].clickData.totalClickRate is required',
      '$.dataByAsin[1].impressionData.asinImpressionShare is not a number',
    ]);
  });
});

describe('SQP share units', () => {
  it('converts percentage shares to canonical fractions and keeps fraction shares', () => {
    const fraction = reportRow({
      searchQuery: 'Synthetic Fraction Query',
      impression: { total: 10_000, asin: 765, share: 0.0765 },
    });
    const small = reportRow({
      searchQuery: 'Synthetic Small Percentage Query',
      impression: { total: 200, asin: 1, share: 0.5 },
    });
    const document = reportDocument([fraction, percentageRow(), small]);
    expect(validate(SCHEMA, document)).toEqual([]);
    const result = parseSqpReport(document, {
      profileId: PROFILE_ID,
      marketplaceId: 'marketplace-1',
      ...WEEK,
      expectedAsins: ['B000000001', 'B000000002'],
    });
    expect(result.counts).toEqual({
      sourceAsins: 2, sourceRows: 3, parsedRows: 3, deduplicatedRows: 3, refusedRows: 0, upserts: 3,
    });
    expect(result.refused).toEqual([]);
    expect(result.firstRefusedRow).toBeNull();
    expect(result.rows).toHaveLength(3);
    const shares = result.rows.map((row) => [
      row.asinImpressionShare, row.asinClickShare, row.asinCartAddShare, row.asinPurchaseShare,
    ]);
    expect(shares[0]).toEqual([0.0765, 0.2, 0.2, 0.4]);
    expect(shares[1]?.[0]).toBeCloseTo(0.1234, 12);
    expect(shares[1]?.slice(1)).toEqual([1, 0, 0]);
    expect(shares[2]?.[0]).toBeCloseTo(0.005, 12);
    for (const row of shares) for (const share of row) expect(share).toBeGreaterThanOrEqual(0);
    for (const row of shares) for (const share of row) expect(share).toBeLessThanOrEqual(1);
  });

  it('stores asin / total for an accepted share, including a share of exactly 1', () => {
    const result = parseSqpReport(reportDocument([
      // 1 as a fraction: the ASIN took every click.
      reportRow({ searchQuery: 'Synthetic Whole Share', click: { total: 7, asin: 7, share: 1 } }),
      // 1 as a percentage: one click in a hundred.
      reportRow({ searchQuery: 'Synthetic One Percent', click: { total: 100, asin: 1, share: 1 } }),
      // A rounded source value: 33.33 % of three clicks is stored as exactly one third.
      reportRow({ searchQuery: 'Synthetic Rounded Share', click: { total: 3, asin: 1, share: 33.33 } }),
    ]), { profileId: PROFILE_ID, marketplaceId: 'marketplace-1', ...WEEK });
    expect(result.counts).toMatchObject({ sourceRows: 3, parsedRows: 3, refusedRows: 0, upserts: 3 });
    expect(result.rows.map((row) => row.asinClickShare)).toEqual([1, 0.01, 1 / 3]);
  });

  it('refuses out-of-range, contradictory and total-less shares with fixed reasons', () => {
    const result = parseSqpReport(reportDocument([
      reportRow({ searchQuery: 'Synthetic A', impression: { total: 80, asin: 8, share: 100.5 } }),
      reportRow({ searchQuery: 'Synthetic B', click: { total: 20, asin: 4, share: -1 } }),
      reportRow({ searchQuery: 'Synthetic C', cartAdd: { total: 10, asin: 1, share: 50 } }),
      reportRow({ searchQuery: 'Synthetic D', purchase: { total: 0, asin: 0, share: 0.3 } }),
      reportRow({ searchQuery: 'Synthetic E', click: { total: 20, asin: 21, share: 1 } }),
    ]), { profileId: PROFILE_ID, marketplaceId: 'marketplace-1', ...WEEK });
    expect(result.counts).toMatchObject({ sourceRows: 5, parsedRows: 0, refusedRows: 5, upserts: 0 });
    expect(result.rows).toEqual([]);
    expect(result.refused).toEqual([
      { index: 0, reason: 'SQP row has out-of-range asinImpressionShare' },
      { index: 1, reason: 'SQP row has out-of-range asinClickShare' },
      { index: 2, reason: 'SQP row asinCartAddShare disagrees with asinCartAddCount and totalCartAddCount' },
      { index: 3, reason: 'SQP row has nonzero asinPurchaseShare with zero totalPurchaseCount' },
      { index: 4, reason: 'SQP row asinClickCount exceeds totalClickCount' },
    ]);
  });
});

describe('SQP refusal summary', () => {
  const MARKER_QUERY = 'Marker Query Zeta';
  const MARKER_ASIN = 'B0000000Z9';
  const MARKER_KEY = 'marker key omega';

  function refusedDocument(): Record<string, unknown> {
    const unknownKeyRow = { ...reportRow({ searchQuery: MARKER_QUERY }), [MARKER_KEY]: 7 };
    delete (unknownKeyRow as Record<string, unknown>)['impressionData'];
    const rows: unknown[] = [
      unknownKeyRow,
      reportRow({ searchQuery: MARKER_QUERY, asin: MARKER_ASIN }),
      reportRow({ searchQuery: `${MARKER_QUERY} 2`, asin: MARKER_ASIN }),
      reportRow({ searchQuery: MARKER_QUERY, impression: { total: 80, asin: 8, share: 4242.42 } }),
      reportRow({ searchQuery: MARKER_QUERY, click: { total: 20, asin: 4, share: 77 } }),
      reportRow({ searchQuery: MARKER_QUERY, purchase: { total: 5, asin: 6, share: 0.4 } }),
      { ...reportRow({ searchQuery: MARKER_QUERY }), startDate: '2026-08-17' },
      'not a row',
      reportRow({ searchQuery: 'Synthetic Accepted Query' }),
    ];
    return reportDocument(rows);
  }

  it('ranks reasons, names only field names, and never carries a row value', () => {
    const context = {
      profileId: PROFILE_ID,
      marketplaceId: 'marketplace-1',
      ...WEEK,
      expectedAsins: ['B000000001'],
    };
    const first = parseSqpReport(refusedDocument(), context);
    const second = parseSqpReport(reportDocument([
      reportRow({ searchQuery: MARKER_QUERY, asin: MARKER_ASIN }),
    ]), context);
    expect(first.counts).toMatchObject({ sourceRows: 9, parsedRows: 1, refusedRows: 8, upserts: 1 });
    expect(second.counts).toMatchObject({ sourceRows: 1, parsedRows: 0, refusedRows: 1, upserts: 0 });

    const summary = summarizeSqpRefusals([first, second]);
    expect(summary).toEqual({
      parserVersion: SQP_PARSER_VERSION,
      sourceRows: 10,
      refusedRows: 9,
      distinctReasons: 7,
      topReasons: [
        { reason: 'SQP row returned an unrequested ASIN', count: 3 },
        { reason: 'row is not an object', count: 1 },
        { reason: 'SQP row asinClickShare disagrees with asinClickCount and totalClickCount', count: 1 },
        { reason: 'SQP row asinPurchaseCount exceeds totalPurchaseCount', count: 1 },
        { reason: 'SQP row has no impressionData', count: 1 },
      ],
      firstRefusedRow: {
        index: 0,
        rowIsObject: true,
        presentFields: expect.arrayContaining(['asin', 'clickData.totalClickRate', 'searchQueryData.searchQuery']),
        missingFields: [
          'impressionData.totalQueryImpressionCount',
          'impressionData.asinImpressionCount',
          'impressionData.asinImpressionShare',
        ],
        unrecognizedFieldCount: 1,
      },
    });
    expect(summary.topReasons.reduce((total, entry) => total + entry.count, 0)).toBe(7);
    expect(summary.firstRefusedRow?.presentFields).toHaveLength(37);

    const line = formatSqpRefusalSummary(summary);
    expect(line).toBe(
      `parser v${SQP_PARSER_VERSION} refused 9 of 10 rows: ` +
      'SQP row returned an unrequested ASIN x3; row is not an object x1; ' +
      'SQP row asinClickShare disagrees with asinClickCount and totalClickCount x1; ' +
      'SQP row asinPurchaseCount exceeds totalPurchaseCount x1; SQP row has no impressionData x1; ' +
      '2 more distinct reasons; first refused row: missing [impressionData.totalQueryImpressionCount, ' +
      'impressionData.asinImpressionCount, impressionData.asinImpressionShare], ' +
      '37 schema fields present, 1 unrecognized',
    );
    const rendered = `${line}\n${JSON.stringify(summary)}\n${JSON.stringify([first.refused, second.refused])}`;
    for (const value of [MARKER_QUERY, 'marker query', MARKER_ASIN, MARKER_KEY, '4242', '77', '2026-08-17', 'not a row']) {
      expect(rendered.toLowerCase()).not.toContain(value.toLowerCase());
    }
  });

  it('maps a contract failure to its field path and never to the zod message', () => {
    const result = parseSqpReport(reportDocument([reportRow()]), {
      profileId: 'not-a-profile-uuid',
      marketplaceId: 'marketplace-1',
    });
    expect(result.refused).toEqual([
      { index: 0, reason: 'SQP row failed the SqpWeeklyFact contract at profileId (invalid_format)' },
    ]);
    expect(result.firstRefusedRow).toMatchObject({ index: 0, missingFields: [], unrecognizedFieldCount: 0 });
  });

  it('reports a non-object first refusal without inventing field names', () => {
    const result = parseSqpReport(reportDocument(['not a row']), {
      profileId: PROFILE_ID,
      marketplaceId: 'marketplace-1',
    });
    const summary = summarizeSqpRefusals([result]);
    expect(summary.firstRefusedRow).toMatchObject({ index: 0, rowIsObject: false, presentFields: [] });
    expect(formatSqpRefusalSummary(summary)).toBe(
      `parser v${SQP_PARSER_VERSION} refused 1 of 1 rows: row is not an object x1; first refused row is not an object`,
    );
  });
});
