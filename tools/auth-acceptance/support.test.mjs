import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { Evidence, root } from './support.mjs';

test('written diagnostics remove generated credentials, links, sessions and local paths', () => {
  const evidence = new Evidence();
  try {
    const generated = () => randomBytes(32).toString('base64url');
    const credential = evidence.secret(generated());
    const applicationToken = generated(); const authHash = generated();
    const session = [generated(), generated(), generated()].join('.');
    const cookie = 'base64-' + generated() + generated();
    const content = [credential, `postgres://synthetic:${generated()}@db:5432/postgres`,
      `https://app.invalid/agency-invite/${applicationToken}?token_hash=${authHash}`,
      session, cookie, root + '/apps/web', process.env.HOME + '/browser-cache'].join('\n');
    evidence.text('diagnostic.log', content);
    const written = readFileSync(resolve(evidence.output, 'diagnostic.log'), 'utf8');
    for (const forbidden of [credential, applicationToken, authHash, session, cookie, root, process.env.HOME]) {
      if (forbidden) assert.ok(!written.includes(forbidden));
    }
    assert.ok(!written.includes('postgres://'));
  } finally { rmSync(evidence.output, { recursive: true, force: true }); }
});

test('sanitized results preserve count assertions and public image/migration digests', () => {
  const evidence = new Evidence();
  try {
    const digest = createHash('sha256').update('synthetic migration').digest('hex');
    const result = { passed: 24, expected: 24, image: 'node@sha256:' + digest, migration: digest };
    evidence.json('result.json', result);
    assert.deepEqual(JSON.parse(readFileSync(resolve(evidence.output, 'result.json'), 'utf8')), result);
  } finally { rmSync(evidence.output, { recursive: true, force: true }); }
});
