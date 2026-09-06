import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const directory = dirname(fileURLToPath(import.meta.url));
export const root = resolve(directory, '../..');
export const web = createRequire(resolve(root, 'apps/web/package.json'));
export const abort = new globalThis.AbortController();
export const email = (label) => `${label}@synthetic-auth.invalid`;
export const sleep = (ms) => delay(ms, undefined, { signal: abort.signal });

export async function waitFor(description, predicate, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    abort.signal.throwIfAborted();
    if (await predicate()) return;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

/** Only sanitized text and selected count/HTTP metadata leave the process. */
export class Evidence {
  secrets = new Set();
  checks = [];
  failures = [];

  constructor() {
    this.output = resolve(root, 'node_modules/.cache/auth-acceptance', `${Date.now()}-${randomBytes(4).toString('hex')}`);
    mkdirSync(this.output, { recursive: true });
  }

  secret(value) { this.secrets.add(value); return value; }
  sanitize(value) {
    let text = String(value);
    for (const secret of this.secrets) if (secret) text = text.replaceAll(secret, '[redacted]');
    text = text.replaceAll(root, '$REPO');
    if (process.env.HOME && process.env.HOME.length > 1) text = text.replaceAll(process.env.HOME, '$HOME');
    return text
      .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/g, '[database connection]')
      .replace(/(\/agency-invite\/|token_hash=)[A-Za-z0-9_-]+/g, '$1[redacted]')
      .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, '[session token]')
      .replace(/\bbase64-[A-Za-z0-9_-]{40,}\b/g, '[session cookie]');
  }
  text(name, value) { writeFileSync(resolve(this.output, name), this.sanitize(value), { mode: 0o600 }); }
  json(name, value) { this.text(name, JSON.stringify(value, null, 2) + '\n'); }
  problem(error) { return { name: error?.name ?? 'Error', message: this.sanitize(error?.message ?? error) }; }
  async check(suite, name, run) {
    abort.signal.throwIfAborted();
    process.stdout.write(`${suite}: ${name}\n`);
    try {
      const counts = await run();
      this.checks.push({ suite, name, passed: true, ...counts });
    } catch (error) {
      this.checks.push({ suite, name, passed: false });
      throw error;
    }
  }
  count(suite, expected) {
    const checks = this.checks.filter((check) => check.suite === suite);
    assert.equal(checks.length, expected, `${suite} must execute every required check`);
    assert.ok(checks.every((check) => check.passed));
  }
}

/** No inherited application credentials or development Auth bypasses. */
export function childEnvironment(additions = {}) {
  return {
    ...Object.fromEntries(['PATH', 'HOME', 'LANG', 'TZ', 'TMPDIR'].filter((key) => process.env[key]).map((key) => [key, process.env[key]])),
    ...additions,
  };
}
