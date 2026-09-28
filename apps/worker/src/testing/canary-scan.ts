/**
 * The canary scan of the MCF privacy suite (WP-338j).
 *
 * A synthetic recipient carries a unique token in every field. After a path
 * has run, every sink it could have written to (log lines, thrown errors,
 * ledger arguments, table rows, a data-only export of the database, alert
 * messages, MCP answers) is searched for each token in six forms:
 *
 *  - plain: the token as typed;
 *  - casefold: the token and the text both lower-cased (an upper-cased or
 *    title-cased copy is still a copy);
 *  - base64 and base64url: the token (as typed, upper-cased and lower-cased)
 *    encoded inside a larger encoded value, at each of the three byte
 *    alignments (a token that starts mid-group encodes differently, so the
 *    stable run of whole groups is searched for each);
 *  - hex: the token's UTF-8 bytes in hex, either case, joined or separated by
 *    spaces (how `console` prints a Buffer);
 *  - url: percent-encoding (`%20`) and form encoding (`+`) of the token.
 *
 * A hit fails with an error that names the sink and nothing else: not the
 * token, not the encoding, not the surrounding text, so a failing run cannot
 * print the value it caught.
 *
 * Synthetic data only. Nothing here reads a file or the network.
 */

export const CANARY_ENCODINGS = ['plain', 'casefold', 'base64', 'base64url', 'hex', 'url'] as const;
export type CanaryEncoding = (typeof CANARY_ENCODINGS)[number];

/** Tokens shorter than this are not unique enough to scan a whole database export for. */
export const CANARY_MIN_LENGTH = 11;

interface Needle {
  readonly encoding: CanaryEncoding;
  readonly form: string;
  /** Searched in the lower-cased text. */
  readonly folded: boolean;
}

/**
 * The runs of whole base64 groups that any encoding of `token` inside a larger
 * value must contain, one per alignment of the token's first byte.
 */
function base64Runs(token: string, url: boolean): string[] {
  const bytes = Buffer.from(token, 'utf8');
  const runs: string[] = [];
  for (let skip = 0; skip < 3; skip += 1) {
    const whole = Math.floor((bytes.length - skip) / 3) * 3;
    if (whole < 9) continue;
    runs.push(bytes.subarray(skip, skip + whole).toString(url ? 'base64url' : 'base64'));
  }
  return runs;
}

function needles(token: string): Needle[] {
  if (token.length < CANARY_MIN_LENGTH) throw new Error('a canary token is too short to be unique');
  const percent = encodeURIComponent(token);
  const cased = [...new Set([token, token.toUpperCase(), token.toLowerCase()])];
  const hex = Buffer.from(token, 'utf8').toString('hex');
  return [
    { encoding: 'plain', form: token, folded: false },
    { encoding: 'casefold', form: token.toLowerCase(), folded: true },
    ...cased.flatMap((variant) => base64Runs(variant, false)).map((form) => ({ encoding: 'base64' as const, form, folded: false })),
    ...cased.flatMap((variant) => base64Runs(variant, true)).map((form) => ({ encoding: 'base64url' as const, form, folded: false })),
    { encoding: 'hex', form: hex, folded: true },
    { encoding: 'hex', form: hex.replace(/(..)(?!$)/g, '$1 '), folded: true },
    { encoding: 'url', form: percent.toLowerCase(), folded: true },
    { encoding: 'url', form: percent.replace(/%20/g, '+').toLowerCase(), folded: true },
  ];
}

/** Every form of every token, for a caller that encodes its own positive control. */
export function canaryForms(tokens: readonly string[]): { encoding: CanaryEncoding; form: string }[] {
  return tokens.flatMap((token) => needles(token).map(({ encoding, form }) => ({ encoding, form })));
}

/** Encodes `text` the way the scan decodes it: used by positive controls to prove each form is found. */
export function encodeForCanaryControl(text: string, encoding: CanaryEncoding): string {
  switch (encoding) {
    case 'plain': return text;
    case 'casefold': return text.toUpperCase();
    case 'base64': return Buffer.from(text, 'utf8').toString('base64');
    case 'base64url': return Buffer.from(text, 'utf8').toString('base64url');
    case 'hex': return Buffer.from(text, 'utf8').toString('hex').toUpperCase();
    case 'url': return encodeURIComponent(text);
  }
}

/**
 * A sink's content as searchable text. Strings as they are; bytes as Latin-1
 * (so ASCII inside binary is visible); errors with name, message, stack, cause
 * and own fields; everything else as JSON with bytes, maps, sets and bigints
 * made visible.
 */
export function sinkText(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'symbol') return String(value);
  if (typeof value === 'function') return '';
  if (seen.has(value)) return '';
  seen.add(value);
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('latin1');
  if (value instanceof Error) {
    const own = Object.fromEntries(Object.entries(value));
    const inner = value instanceof AggregateError ? sinkText(value.errors, seen) : '';
    return [value.name, value.message, value.stack ?? '', sinkText(value.cause, seen), inner, sinkText(own, seen)].join('\n');
  }
  if (Array.isArray(value)) return value.map((item) => sinkText(item, seen)).join('\n');
  if (value instanceof Map) return sinkText([...value.entries()], seen);
  if (value instanceof Set) return sinkText([...value.values()], seen);
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') return item.toString();
    if (item instanceof Uint8Array) return Buffer.from(item.buffer, item.byteOffset, item.byteLength).toString('latin1');
    if (item instanceof Error || item instanceof Map || item instanceof Set) return sinkText(item);
    if (typeof item === 'object' && item !== null && (item as { type?: unknown }).type === 'Buffer' && Array.isArray((item as { data?: unknown }).data)) {
      return Buffer.from((item as { data: number[] }).data).toString('latin1');
    }
    return item;
  }) ?? '';
}

export interface CanaryHit {
  readonly sink: string;
  readonly encoding: CanaryEncoding;
}

/** Every (sink, encoding) with at least one token found. For assertions, use assertNoCanary: it prints nothing but sink names. */
export function canaryHits(tokens: readonly string[], sinks: Readonly<Record<string, unknown>>): CanaryHit[] {
  const all = tokens.flatMap(needles);
  const hits: CanaryHit[] = [];
  for (const [sink, value] of Object.entries(sinks)) {
    const text = sinkText(value);
    const folded = text.toLowerCase();
    const found = new Set<CanaryEncoding>();
    for (const needle of all) {
      if (found.has(needle.encoding)) continue;
      if ((needle.folded ? folded : text).includes(needle.form)) found.add(needle.encoding);
    }
    for (const encoding of found) hits.push({ sink, encoding });
  }
  return hits;
}

/** Whether any token is in `value` in any form: the positive control. */
export function canaryPresent(tokens: readonly string[], value: unknown): boolean {
  return canaryHits(tokens, { control: value }).length > 0;
}

/** Thrown by assertNoCanary. The message names sinks only. */
export class CanaryLeakError extends Error {
  constructor(readonly sinks: readonly string[]) {
    super(`recipient canary found in sink: ${sinks.join(', ')}`);
    this.name = 'CanaryLeakError';
  }
}

/** Fails when any token is in any sink in any form, naming the sinks and nothing else. */
export function assertNoCanary(tokens: readonly string[], sinks: Readonly<Record<string, unknown>>): void {
  const leaking = [...new Set(canaryHits(tokens, sinks).map((hit) => hit.sink))];
  if (leaking.length > 0) throw new CanaryLeakError(leaking);
}
