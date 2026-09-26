import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MARKET_SIGNALS_ID_NAMESPACE,
  MarketSignalsChangePoint,
  MarketSignalsHeader,
  MarketSignalsObservation,
  MarketSignalsRecord,
  MarketSignalsSignal,
} from './market-signals.js';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Schema = { [key: string]: Json };

const schema = JSON.parse(readFileSync(new URL('./market-signals-2.schema.json', import.meta.url), 'utf8')) as Schema;

/**
 * The JSON Schema 2020-12 keywords the vendored file uses, and nothing more.
 * An unknown keyword throws, so a future schema cannot pass by being ignored.
 */
const ANNOTATIONS = new Set(['$schema', '$id', '$comment', 'title', 'description', '$defs']);
function valid(node: Json, value: Json, root: Schema = schema): boolean {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) throw new Error('schema node must be an object');
  for (const [keyword, argument] of Object.entries(node)) {
    if (ANNOTATIONS.has(keyword) || keyword === 'then') continue;
    if (!keywordHolds(keyword, argument, node, value, root)) return false;
  }
  return true;
}
function typeOf(value: Json): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
function hasType(type: string, value: Json): boolean {
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  return typeOf(value) === type;
}
function keywordHolds(keyword: string, argument: Json, node: Schema, value: Json, root: Schema): boolean {
  const record = typeOf(value) === 'object' ? value as { [key: string]: Json } : null;
  switch (keyword) {
    case '$ref': {
      const name = String(argument).replace('#/$defs/', '');
      const target = (root['$defs'] as Schema)[name];
      if (target === undefined) throw new Error(`unresolved $ref ${String(argument)}`);
      return valid(target, value, root);
    }
    case 'type': return (Array.isArray(argument) ? argument : [argument]).some((type) => hasType(String(type), value));
    case 'enum': return (argument as Json[]).some((option) => JSON.stringify(option) === JSON.stringify(value));
    case 'const': return JSON.stringify(argument) === JSON.stringify(value);
    case 'pattern': return typeof value !== 'string' || new RegExp(String(argument), 'u').test(value);
    case 'minLength': return typeof value !== 'string' || [...value].length >= Number(argument);
    case 'minimum': return typeof value !== 'number' || value >= Number(argument);
    case 'maximum': return typeof value !== 'number' || value <= Number(argument);
    case 'required': return record === null || (argument as string[]).every((name) => name in record);
    case 'properties': return record === null || Object.entries(argument as Schema)
      .every(([name, child]) => !(name in record) || valid(child, record[name]!, root));
    case 'additionalProperties': {
      if (argument !== false) throw new Error('only additionalProperties: false is supported');
      const known = Object.keys((node['properties'] ?? {}) as Schema);
      return record === null || Object.keys(record).every((name) => known.includes(name));
    }
    case 'items': return !Array.isArray(value) || value.every((item) => valid(argument, item, root));
    case 'oneOf': return (argument as Json[]).filter((option) => valid(option, value, root)).length === 1;
    case 'allOf': return (argument as Json[]).every((option) => valid(option, value, root));
    case 'if': return !valid(argument, value, root) || node['then'] === undefined || valid(node['then'], value, root);
    default: throw new Error(`unsupported JSON Schema keyword ${keyword}`);
  }
}

function uuid5(name: string, namespace = MARKET_SIGNALS_ID_NAMESPACE): string {
  const bytes = createHash('sha1')
    .update(Buffer.from(namespace.replaceAll('-', ''), 'hex'))
    .update(name, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// The four example records from the hand-off, re-typed with synthetic values.
// Ids are derived exactly as the exporter derives them.
const ASIN = 'B0SYNHERO1';
const KEY = `Synthetic Store|US|ASIN:${ASIN}|buybox_lost`;
const SIGNAL_ID = uuid5(`${KEY}|2026-09-24T23:00Z`);
/** Record ids hash their natural key under a `market-signals/2/<kind>|` prefix. */
const exportId = (kind: string, ...parts: string[]) => uuid5([`market-signals/2/${kind}`, ...parts].join('|'));
const mark = (path: string) => ({
  at: '2026-09-25T01:00:00Z', id: exportId('tag_mark', SIGNAL_ID, path, 'add', '2026-09-25T01:00:00Z'),
  op: 'add', path, rules: '3.off', source: 'rule', stage: 'live', tag_id: uuid5(path),
});
const examples: Record<'header' | 'observation' | 'change_point' | 'signal', { [key: string]: Json }> = {
  header: {
    counts: { change_point: 1, observation: 1, signal: 1 }, generated_at: '2026-09-25T02:00:00Z', kind: 'header',
    mode: 'full', org_key: 'synthetic-org', schema: 'market-signals/2', since: null, source: 'wizards-ai',
    state_generated_at: '2026-09-25T01:00:00Z',
  },
  observation: {
    asin: ASIN, bsr: 1100, buy_box_price: 31.99, category: '11',
    id: exportId('observation', 'US', ASIN, '2026-09-25T00:00:00Z'), kind: 'observation', marketplace: 'US',
    observed_at: '2026-09-25T00:00:00Z', offer_count: 3, org_key: 'synthetic-org', price: null,
    profile_key: 'synthetic-us', rating: null, review_count: null, role: 'own',
  },
  change_point: {
    asin: ASIN, at: '2026-09-24T23:00:00Z', id: exportId('change_point', 'US', ASIN, 'holder', '2026-09-24T23:00:00Z'),
    kind: 'change_point', marketplace: 'US', observation: `US|${ASIN}`, org_key: 'synthetic-org',
    profile_key: 'synthetic-us', role: 'own', track: 'holder', value: 'A0SYNTHOTHER1',
  },
  signal: {
    account: 'Synthetic Store', asin: ASIN, band: 4, because: 'hero_holder_not_ours', family: 'buybox',
    figures: { holder: 'A0SYNTHOTHER1', ours: 'A0SYNTHOURS01', since: '2026-09-24T23:00:00+00:00' },
    first_fired_at: '2026-09-25T01:00:00Z', hero: true, holder: 'third_party', id: SIGNAL_ID, issue_type: 'buybox_lost',
    key: KEY, kind: 'signal', last_movement: '2026-09-25T01:00:00Z', marketplace: 'US', onset_at: '2026-09-24T23:00:00Z',
    org_key: 'synthetic-org', parent_asin: null, profile_key: 'synthetic-us', resolved_at: null, route: 'now',
    route_source: 'rule', severity: 'high', status: 'open', summary: 'Buy Box held by A0SYNTHOTHER1, not us (A0SYNTHOURS01)',
    tag_marks: [mark('signal/family/buybox'), mark('signal/route/now')],
  },
};

const zodFor = {
  header: MarketSignalsHeader,
  observation: MarketSignalsObservation,
  change_point: MarketSignalsChangePoint,
  signal: MarketSignalsSignal,
} as const;

// Each mutation must be refused by both validators, or accepted by both.
const mutations: Array<[keyof typeof examples, string, (record: { [key: string]: Json }) => void]> = [
  ['header', 'wrong schema version', (r) => { r['schema'] = 'market-signals/1'; }],
  ['header', 'local time without Z', (r) => { r['generated_at'] = '2026-09-25T02:00:00'; }],
  ['header', 'null data-as-of', (r) => { r['state_generated_at'] = null; }],
  ['header', 'fractional seconds', (r) => { r['generated_at'] = '2026-09-25T02:00:00.123456Z'; }],
  ['header', 'extra count', (r) => { r['counts'] = { change_point: 1, observation: 1, signal: 1, tag_mark: 2 }; }],
  ['header', 'negative count', (r) => { r['counts'] = { change_point: -1, observation: 1, signal: 1 }; }],
  ['header', 'unknown mode', (r) => { r['mode'] = 'hourly'; }],
  ['observation', 'uuid4 id', (r) => { r['id'] = '0c92ced4-e2c4-4b67-8f11-46301f618a3d'; }],
  ['observation', 'lower-case marketplace', (r) => { r['marketplace'] = 'us'; }],
  ['observation', 'short ASIN', (r) => { r['asin'] = 'B0SHORT'; }],
  ['observation', 'fractional BSR', (r) => { r['bsr'] = 1100.5; }],
  ['observation', 'rating above five', (r) => { r['rating'] = 5.5; }],
  ['observation', 'named category', (r) => { r['category'] = 'Widgets'; }],
  ['observation', 'empty category', (r) => { r['category'] = ''; }],
  ['observation', 'missing offer count', (r) => { delete r['offer_count']; }],
  ['observation', 'unknown role', (r) => { r['role'] = 'watch'; }],
  ['observation', 'null profile key', (r) => { r['profile_key'] = null; }],
  ['change_point', 'holder not a merchant id', (r) => { r['value'] = 'somebody'; }],
  ['change_point', 'suppressed holder', (r) => { r['value'] = 'suppressed'; }],
  ['change_point', 'price no offer', (r) => { r['track'] = 'buybox_price'; r['value'] = 'no_offer'; }],
  ['change_point', 'price text', (r) => { r['track'] = 'new_price'; r['value'] = 'cheap'; }],
  ['change_point', 'negative price', (r) => { r['track'] = 'new_fba_price'; r['value'] = -1; }],
  ['change_point', 'fractional rank', (r) => { r['track'] = 'rank'; r['value'] = 3.5; }],
  ['change_point', 'offer count no offer', (r) => { r['track'] = 'offer_count'; r['value'] = 'no_offer'; }],
  ['change_point', 'category list', (r) => { r['track'] = 'category_ids'; r['value'] = ['11', '12']; }],
  ['change_point', 'category list of numbers', (r) => { r['track'] = 'category_ids'; r['value'] = [11]; }],
  ['change_point', 'dimensions as array', (r) => { r['track'] = 'package_dimensions'; r['value'] = [190]; }],
  ['change_point', 'null fee', (r) => { r['track'] = 'fba_fee'; r['value'] = null; }],
  ['change_point', 'unknown track', (r) => { r['track'] = 'coupon'; r['value'] = 1; }],
  ['change_point', 'bad observation id', (r) => { r['observation'] = `US/${ASIN}`; }],
  ['signal', 'band five', (r) => { r['band'] = 5; }],
  ['signal', 'unknown issue type', (r) => { r['issue_type'] = 'price_war'; }],
  ['signal', 'unknown override', (r) => { r['because'] = 'manual'; }],
  ['signal', 'resolved episode', (r) => { r['status'] = 'resolved'; r['resolved_at'] = '2026-09-26T01:00:00Z'; }],
  ['signal', 'key without ASIN prefix', (r) => { r['key'] = `Synthetic Store|US|${ASIN}|buybox_lost`; }],
  ['signal', 'shadow mark', (r) => { (r['tag_marks'] as { [key: string]: Json }[])[0]!['stage'] = 'shadow'; }],
  ['signal', 'mark path too deep', (r) => { (r['tag_marks'] as { [key: string]: Json }[])[0]!['path'] = 'signal/family/buybox/extra'; }],
  ['signal', 'mark with extra field', (r) => { (r['tag_marks'] as { [key: string]: Json }[])[0]!['note'] = 'x'; }],
  ['signal', 'figures as list', (r) => { r['figures'] = []; }],
];

describe('market-signals/2 contract', () => {
  it('derives the example ids the way the exporter does', () => {
    // The hand-off's own published example ids, recomputed from their names.
    expect(uuid5('signal/family/buybox')).toBe('6c124524-519b-5002-a562-538bd1ceee41');
    expect(uuid5('signal/route/now')).toBe('d668172c-4fac-532e-8452-82720cf4094f');
    for (const record of Object.values(examples)) {
      if (typeof record['id'] === 'string') expect(record['id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5/);
    }
  });

  it('accepts the four example records with both the vendored schema and the zod parsers', () => {
    const kinds = Object.keys(examples) as (keyof typeof examples)[];
    expect(kinds).toHaveLength(4);
    for (const kind of kinds) {
      expect(valid(schema, examples[kind]), `JSON Schema ${kind}`).toBe(true);
      expect(zodFor[kind].safeParse(examples[kind]).success, `zod ${kind}`).toBe(true);
      expect(MarketSignalsRecord.safeParse(examples[kind]).success, `zod record ${kind}`).toBe(true);
      expect(valid((schema['$defs'] as Schema)[kind]!, examples[kind]), `JSON Schema $defs.${kind}`).toBe(true);
    }
  });

  it('agrees with the vendored schema on every mutation of the examples', () => {
    const verdicts: Array<{ label: string; jsonSchema: boolean; zod: boolean }> = [];
    for (const [kind, label, mutate] of mutations) {
      const record = structuredClone(examples[kind]);
      mutate(record);
      verdicts.push({ label, jsonSchema: valid(schema, record), zod: MarketSignalsRecord.safeParse(record).success });
    }
    expect(verdicts).toHaveLength(mutations.length);
    expect(verdicts.filter((verdict) => verdict.jsonSchema !== verdict.zod)).toEqual([]);
    // Both outcomes are exercised, so agreement is not vacuous.
    expect(verdicts.filter((verdict) => verdict.zod).map((verdict) => verdict.label).sort()).toEqual([
      'category list', 'empty category', 'fractional seconds', 'null data-as-of', 'null fee', 'null profile key',
      'offer count no offer', 'price no offer', 'resolved episode', 'shadow mark', 'suppressed holder',
    ]);
  });

  it('refuses a record of one kind wearing another kind', () => {
    const disguised = { ...examples.observation, kind: 'signal' };
    expect(valid(schema, disguised)).toBe(false);
    expect(MarketSignalsRecord.safeParse(disguised).success).toBe(false);
  });

  it('carries the origin note on the vendored schema', () => {
    expect(String(schema['$comment'])).toContain('wizards-ai');
    expect(String(schema['$comment'])).toContain('S8, 25 Sept 2026');
    expect(schema['title']).toBe('market-signals/2');
    // The escaped holder pattern parses to the published one, assembled here from fragments.
    const holder = (((schema['$defs'] as Schema)['change_point'] as Schema)['allOf'] as Schema[])[0]!;
    expect(((holder['then'] as Schema)['properties'] as Schema)['value']).toEqual({
      type: 'string', pattern: ['^(A[0-9A-Z]{5,20}', 'suppressed', 'unidentified)$'].join('|'),
    });
  });
});
