import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SpApiStartDatabaseRefusal, SpApiStartField, SpApiStartRefusalClass, type SpApiStartRefusal } from '@wizard-ads/shared';
import { parseSpApiStartRefusal, SP_API_START_DATABASE_REFUSALS, SP_API_START_SETTINGS, spApiStartRefusalMessage } from './spapi-start-refusal';

const migrations = new URL('../../../../../supabase/migrations/', import.meta.url);

/** Every admissible refusal, enumerated from the contract rather than listed by hand. */
function everyRefusal(): SpApiStartRefusal[] {
  return SpApiStartRefusalClass.options.flatMap((refusal): SpApiStartRefusal[] => {
    if (refusal === 'configuration') return SP_API_START_SETTINGS.map((detail) => ({ refusal, detail }));
    if (refusal === 'selection') return SpApiStartField.options.map((detail) => ({ refusal, detail }));
    if (refusal === 'database') return [{ refusal, detail: null }, ...SpApiStartDatabaseRefusal.options.map((detail) => ({ refusal, detail }))];
    return [{ refusal, detail: null }];
  });
}

describe('SP-API start refusal copy', () => {
  it('gives every admissible refusal its own message', () => {
    const refusals = everyRefusal();
    const expected = SP_API_START_SETTINGS.length + SpApiStartField.options.length + SpApiStartDatabaseRefusal.options.length + 7;
    expect(refusals).toHaveLength(expected);
    const messages = refusals.map(spApiStartRefusalMessage);
    expect(new Set(messages).size).toBe(expected);
    for (const message of messages) expect(message).toMatch(/^[A-Z].+\.$/);
    for (const setting of SP_API_START_SETTINGS) expect(spApiStartRefusalMessage({ refusal: 'configuration', detail: setting })).toContain(setting);
  });

  it('names only database texts that the migrations raise with the same SQLSTATE', () => {
    const files = readdirSync(migrations).filter((name) => name.endsWith('.sql'));
    expect(files.length).toBeGreaterThan(0);
    const sql = files.map((name) => readFileSync(new URL(name, migrations), 'utf8')).join('\n');
    const raised = new Set([
      ...[...sql.matchAll(/raise exception '([^']+)' using errcode = '([0-9A-Z]{5})'/g)].map(([, text, code]) => `${code} ${text}`),
      ...[...sql.matchAll(/raise exception using errcode = '([0-9A-Z]{5})', message = '([^']+)'/g)].map(([, code, text]) => `${code} ${text}`),
    ]);
    const listed = SpApiStartDatabaseRefusal.options.map((key) => `${SP_API_START_DATABASE_REFUSALS[key].sqlstate} ${SP_API_START_DATABASE_REFUSALS[key].text}`);
    expect(listed).toHaveLength(9);
    expect(listed.filter((entry) => raised.has(entry))).toEqual(listed);
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('parses only fixed codes from the redirect query', () => {
    expect(parseSpApiStartRefusal('configuration', 'AMAZON_OAUTH_STATE_KEY')).toEqual({ refusal: 'configuration', detail: 'AMAZON_OAUTH_STATE_KEY' });
    expect(parseSpApiStartRefusal('database', undefined)).toEqual({ refusal: 'database', detail: null });
    expect(parseSpApiStartRefusal('session', null)).toEqual({ refusal: 'session', detail: null });
    for (const [error, detail] of [
      ['configuration', null], ['configuration', 'synthetic-untrusted-setting'], ['configuration', 'SYNTHETIC_UNLISTED_SETTING'],
      ['selection', 'profileId'], ['session', 'label'],
      ['database', 'synthetic-untrusted-text'], ['reused', null], ['synthetic-untrusted-class', null], [['session'], null],
    ] as const) {
      expect(parseSpApiStartRefusal(error, detail)).toBeNull();
    }
  });
});
