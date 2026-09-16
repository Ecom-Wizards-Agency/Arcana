/** Private bounded JSON boundary shared by SP creation responses and exact readbacks. */
// Preserve number tokens before JavaScript can round an identity or normalize an index.
export class JsonNumber {
  constructor(readonly source: string) {}
}
export type JsonValue = null | boolean | string | JsonNumber | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export function object(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && !(value instanceof JsonNumber);
}

/** Bounded JSON grammar with duplicate-member rejection, including escaped member names. */
export function parse(body: Uint8Array): JsonValue {
  if (body.length > 1_048_576) throw new Error('body_limit');
  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
  let cursor = 0;
  const whitespace = () => { while (/^[\x20\t\n\r]$/.test(source[cursor] ?? '')) cursor += 1; };
  const invalid = (): never => { throw new Error('invalid_json'); };
  const string = (): string => {
    const start = cursor++;
    while (cursor < source.length) {
      const character = source[cursor++];
      if (character === '\\') cursor += 1;
      else if (character === '"') return JSON.parse(source.slice(start, cursor)) as string;
    }
    return invalid();
  };
  const value = (depth: number): JsonValue => {
    if (depth > 64) return invalid();
    whitespace();
    const first = source[cursor];
    if (first === '"') return string();
    if (first === '{' || first === '[') {
      cursor += 1;
      const entries: JsonObject = Object.create(null) as JsonObject;
      const items: JsonValue[] = [];
      const close = first === '{' ? '}' : ']';
      whitespace();
      if (source[cursor] === close) { cursor += 1; return first === '{' ? entries : items; }
      while (cursor < source.length) {
        whitespace();
        if (first === '{') {
          if (source[cursor] !== '"') return invalid();
          const key = string();
          if (Object.hasOwn(entries, key)) return invalid();
          whitespace();
          if (source[cursor++] !== ':') return invalid();
          entries[key] = value(depth + 1);
        } else items.push(value(depth + 1));
        whitespace();
        const separator = source[cursor++];
        if (separator === close) return first === '{' ? entries : items;
        if (separator !== ',') return invalid();
      }
      return invalid();
    }
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]] as const) {
      if (source.startsWith(literal, cursor)) { cursor += literal.length; return result; }
    }
    const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(cursor))?.[0];
    if (token === undefined) return invalid();
    cursor += token.length;
    return new JsonNumber(token);
  };
  const result = value(0);
  whitespace();
  if (cursor !== source.length) return invalid();
  return result;
}

export function identity(value: JsonValue | undefined): value is string {
  // S1 specifies strings for every supported ID. Numeric tokens are never coerced.
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && value.trim() === value && !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}
