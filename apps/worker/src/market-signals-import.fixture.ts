/**
 * Synthetic `market-signals/2` batches for tests: the hand-off's four example
 * records re-typed with invented ASINs, keys and names, ids derived exactly as
 * the exporter derives them. No line comes from a real export.
 */
import { createHash } from 'node:crypto';
import { MARKET_SIGNALS_ID_NAMESPACE } from '@wizard-ads/shared';

export function uuid5(name: string, namespace: string = MARKET_SIGNALS_ID_NAMESPACE): string {
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

/** Record ids hash their natural key under a `market-signals/2/<kind>|` prefix. */
export function exportId(kind: 'observation' | 'change_point' | 'tag_mark', ...parts: string[]): string {
  return uuid5([`market-signals/2/${kind}`, ...parts].join('|'));
}

export type FixtureRecord = Record<string, unknown>;

export const FIXTURE_ORG_KEY = 'synthetic-org';
export const FIXTURE_PROFILE_US = 'synthetic-us';
export const FIXTURE_PROFILE_DE = 'synthetic-de';
export const FIXTURE_OWN_ASIN = 'B0SYNHERO1';
export const FIXTURE_RIVAL_ASIN = 'B0SYNRIVL1';
const ACCOUNT = 'Synthetic Store';
/** The rival's Buy Box: 20, 20 (rank moved), 15 (drop), 20 (restore). */
export const FIXTURE_RIVAL_TIMES = ['2026-09-24T20:00:00Z', '2026-09-24T21:00:00Z', '2026-09-24T22:00:00Z', '2026-09-25T00:00:00Z'] as const;

function observation(input: {
  marketplace: string; asin: string; role: 'own' | 'competitor'; profileKey: string; observedAt: string;
  bsr: number | null; price: number | null; buyBoxPrice: number | null; offerCount: number | null;
  rating?: number | null; reviewCount?: number | null; category?: string; orgKey?: string;
}): FixtureRecord {
  return {
    kind: 'observation',
    id: exportId('observation', input.marketplace, input.asin, input.observedAt),
    org_key: input.orgKey ?? FIXTURE_ORG_KEY, profile_key: input.profileKey, marketplace: input.marketplace,
    asin: input.asin, role: input.role, observed_at: input.observedAt, category: input.category ?? '11',
    bsr: input.bsr, price: input.price, rating: input.rating ?? null, review_count: input.reviewCount ?? null,
    buy_box_price: input.buyBoxPrice, offer_count: input.offerCount,
  };
}

function changePoint(input: {
  marketplace: string; asin: string; role: 'own' | 'competitor'; profileKey: string; track: string; at: string; value: unknown;
}): FixtureRecord {
  return {
    kind: 'change_point',
    id: exportId('change_point', input.marketplace, input.asin, input.track, input.at),
    org_key: FIXTURE_ORG_KEY, profile_key: input.profileKey, marketplace: input.marketplace, asin: input.asin,
    role: input.role, observation: `${input.marketplace}|${input.asin}`, track: input.track, at: input.at, value: input.value,
  };
}

function signalId(key: string, onsetAt: string): string {
  return uuid5(`${key}|${onsetAt.slice(0, 16)}Z`);
}

function mark(signal: string, path: string, op: 'add' | 'remove', at: string, extra: Partial<FixtureRecord> = {}): FixtureRecord {
  return {
    id: exportId('tag_mark', signal, path, op, at), tag_id: uuid5(path), path, op, at,
    source: 'rule', stage: 'live', rules: '3.off', ...extra,
  };
}

const HERO_KEY = `${ACCOUNT}|US|ASIN:${FIXTURE_OWN_ASIN}|buybox_lost`;
const HERO_ONSET = '2026-09-24T23:00:00Z';
export const FIXTURE_HERO_SIGNAL_ID = signalId(HERO_KEY, HERO_ONSET);
const RANK_KEY = `${ACCOUNT}|DE|ASIN:${FIXTURE_OWN_ASIN}|bsr_degradation`;
const RANK_ONSET = '2026-09-24T12:00:00Z';
export const FIXTURE_RANK_SIGNAL_ID = signalId(RANK_KEY, RANK_ONSET);

function heroMarks(): FixtureRecord[] {
  return [
    mark(FIXTURE_HERO_SIGNAL_ID, 'signal/family/buybox', 'add', '2026-09-25T01:00:00Z'),
    mark(FIXTURE_HERO_SIGNAL_ID, 'signal/route/now', 'add', '2026-09-25T01:00:00Z'),
    mark(FIXTURE_HERO_SIGNAL_ID, 'signal/jev/confirmed', 'add', '2026-09-25T01:00:00Z', { source: 'jev', stage: 'shadow', rules: '3.shadow' }),
  ];
}

function heroSignal(overrides: Partial<FixtureRecord> = {}): FixtureRecord {
  return {
    kind: 'signal', id: FIXTURE_HERO_SIGNAL_ID, key: HERO_KEY, org_key: FIXTURE_ORG_KEY, profile_key: FIXTURE_PROFILE_US,
    account: ACCOUNT, marketplace: 'US', asin: FIXTURE_OWN_ASIN, parent_asin: null, issue_type: 'buybox_lost',
    family: 'buybox', severity: 'high', route: 'now', route_source: 'rule', because: 'hero_holder_not_ours',
    status: 'open', band: 4, hero: true, holder: 'third_party', onset_at: HERO_ONSET,
    first_fired_at: '2026-09-25T01:00:00Z', last_movement: '2026-09-25T01:00:00Z', resolved_at: null,
    summary: 'Buy Box held by A0SYNTHOTHER1, not us (A0SYNTHOURS01)',
    figures: { holder: 'A0SYNTHOTHER1', ours: 'A0SYNTHOURS01', since: '2026-09-24T23:00:00+00:00' },
    tag_marks: heroMarks(),
    ...overrides,
  };
}

function header(input: { generatedAt: string; stateGeneratedAt: string | null; mode: 'full' | 'since' | 'delta'; records: FixtureRecord[]; orgKey?: string }): FixtureRecord {
  const count = (kind: string) => input.records.filter((record) => record['kind'] === kind).length;
  return {
    kind: 'header', schema: 'market-signals/2', source: 'wizards-ai', org_key: input.orgKey ?? FIXTURE_ORG_KEY,
    generated_at: input.generatedAt, state_generated_at: input.stateGeneratedAt, mode: input.mode, since: null,
    counts: { observation: count('observation'), change_point: count('change_point'), signal: count('signal') },
  };
}

/** One full batch with records of every kind: 6 observations, 7 change points, 2 signals, 7 tag marks. */
export function firstBatch(orgKey: string = FIXTURE_ORG_KEY): FixtureRecord[] {
  const [t1, t2, t3, t4] = FIXTURE_RIVAL_TIMES;
  const rival = (observedAt: string, bsr: number, buyBoxPrice: number, price: number) => observation({
    marketplace: 'US', asin: FIXTURE_RIVAL_ASIN, role: 'competitor', profileKey: FIXTURE_PROFILE_US, observedAt, bsr, price, buyBoxPrice, offerCount: 4, orgKey,
  });
  const rivalPoint = (track: string, at: string, value: unknown) => changePoint({
    marketplace: 'US', asin: FIXTURE_RIVAL_ASIN, role: 'competitor', profileKey: FIXTURE_PROFILE_US, track, at, value,
  });
  const records: FixtureRecord[] = [
    observation({ marketplace: 'US', asin: FIXTURE_OWN_ASIN, role: 'own', profileKey: FIXTURE_PROFILE_US, observedAt: '2026-09-25T00:00:00Z', bsr: 1100, price: null, buyBoxPrice: 31.99, offerCount: 3, orgKey }),
    observation({ marketplace: 'DE', asin: FIXTURE_OWN_ASIN, role: 'own', profileKey: FIXTURE_PROFILE_DE, observedAt: '2026-09-25T00:00:00Z', bsr: 2100, price: 28.5, buyBoxPrice: 29.99, offerCount: 2, rating: 4.4, reviewCount: 120, orgKey }),
    rival(t1, 500, 20, 21), rival(t2, 450, 20, 21), rival(t3, 300, 15, 16), rival(t4, 350, 20, 21),
    changePoint({ marketplace: 'US', asin: FIXTURE_OWN_ASIN, role: 'own', profileKey: FIXTURE_PROFILE_US, track: 'holder', at: HERO_ONSET, value: 'A0SYNTHOTHER1' }),
    rivalPoint('buybox_price', '2026-09-24T19:00:00Z', 'no_offer'),
    rivalPoint('buybox_price', t1, 20), rivalPoint('rank', t2, 450), rivalPoint('buybox_price', t3, 15),
    rivalPoint('new_price', t3, 16), rivalPoint('buybox_price', t4, 20),
    heroSignal(),
    {
      kind: 'signal', id: FIXTURE_RANK_SIGNAL_ID, key: RANK_KEY, org_key: FIXTURE_ORG_KEY, profile_key: FIXTURE_PROFILE_DE,
      account: ACCOUNT, marketplace: 'DE', asin: FIXTURE_OWN_ASIN, parent_asin: 'B0SYNPARNT', issue_type: 'bsr_degradation',
      family: 'rank', severity: 'medium', route: 'weekly', route_source: 'rule', because: null, status: 'resolved', band: 2,
      hero: false, holder: null, onset_at: RANK_ONSET, first_fired_at: '2026-09-24T13:00:00Z',
      last_movement: '2026-09-24T13:00:00Z', resolved_at: '2026-09-25T01:00:00Z', summary: 'Rank fell from 1400 to 2100 (+50%)',
      figures: { change_pct: 50, baseline: 1400 },
      tag_marks: [
        mark(FIXTURE_RANK_SIGNAL_ID, 'signal/family/rank', 'add', '2026-09-24T13:00:00Z'),
        mark(FIXTURE_RANK_SIGNAL_ID, 'signal/band/2', 'add', '2026-09-24T13:00:00Z'),
        mark(FIXTURE_RANK_SIGNAL_ID, 'signal/family/rank', 'remove', '2026-09-25T01:00:00Z'),
        mark(FIXTURE_RANK_SIGNAL_ID, 'signal/band/2', 'remove', '2026-09-25T01:00:00Z'),
      ],
    },
  ].map((record) => ({ ...record, org_key: orgKey }));
  return [header({ generatedAt: '2026-09-25T02:00:00Z', stateGeneratedAt: '2026-09-25T01:00:00Z', mode: 'full', records, orgKey }), ...records];
}

/** The next hourly delta: the hero episode resolves and drops its three tags. */
export function secondBatch(): FixtureRecord[] {
  const at = '2026-09-25T03:00:00Z';
  const records = [heroSignal({
    status: 'resolved', resolved_at: at, last_movement: '2026-09-25T01:00:00Z',
    tag_marks: [
      ...heroMarks(),
      mark(FIXTURE_HERO_SIGNAL_ID, 'signal/family/buybox', 'remove', at),
      mark(FIXTURE_HERO_SIGNAL_ID, 'signal/route/now', 'remove', at),
      mark(FIXTURE_HERO_SIGNAL_ID, 'signal/jev/confirmed', 'remove', at, { source: 'jev', stage: 'shadow', rules: '3.shadow' }),
    ],
  })];
  return [header({ generatedAt: at, stateGeneratedAt: '2026-09-25T02:00:00Z', mode: 'delta', records }), ...records];
}

export function toNdjson(records: readonly FixtureRecord[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}
