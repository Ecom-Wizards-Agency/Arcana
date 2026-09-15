#!/usr/bin/env node
import assert from 'node:assert/strict';
import process from 'node:process';
import { Application, applicationOrigin } from './application.mjs';
import { browserChecks, browserSuite } from './browser.mjs';
import { providerChecks, providerSuite } from './provider.mjs';
import { AuthStack, images, prepareImages } from './stack.mjs';
import { abort, Evidence, root, web } from './support.mjs';

const evidence = new Evidence();
const started = new Date().toISOString();
const stacks = [];
let application;
let failed = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    abort.abort(new Error(`Interrupted by ${signal}`));
    // Closing Chromium/Next interrupts pending browser actions; provider waits
    // and HTTP calls use the same abort signal. Finally owns resource deletion.
    void application?.close().catch(() => {});
  });
}

try {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 22, 'Node 22 or newer is required');
  assert.equal(process.argv.length, 2, 'This required suite has no skip or service-URL arguments');
  prepareImages();
  const provider = new AuthStack(evidence, 'provider'); stacks.push(provider);
  try {
    await provider.start({ expirySeconds: 5 });
    await providerSuite(provider, evidence);
  } finally { await provider.close(); }

  const browser = new AuthStack(evidence, 'browser'); stacks.push(browser);
  try {
    await browser.start({ appOrigin: await applicationOrigin(), expirySeconds: 600 });
    application = new Application(browser, evidence);
    await browserSuite(browser, application, evidence);
  } finally {
    try { await application?.close(); } finally { await browser.close(); }
  }
  evidence.count('provider', providerChecks); evidence.count('browser', browserChecks);
} catch (error) {
  failed = true; evidence.failures.push(evidence.problem(error));
} finally {
  for (const stack of stacks) {
    try { await stack.close(); } catch (error) { failed = true; evidence.failures.push(evidence.problem(error)); }
  }
  const expected = providerChecks + browserChecks;
  const passed = evidence.checks.filter((check) => check.passed).length;
  if (passed !== expected || abort.signal.aborted) failed = true;
  const report = {
    started, finished: new Date().toISOString(), expected, passed, failed,
    versions: { node: process.versions.node, next: web('next/package.json').version, sdk: web('@supabase/supabase-js/package.json').version, ssr: web('@supabase/ssr/package.json').version },
    images, checks: evidence.checks, failures: evidence.failures,
    migrations: stacks.find((stack) => stack.suite === 'browser')?.migrations ?? [],
    cleanup: stacks.map((stack) => ({ suite: stack.suite, ...stack.cleanupResult })),
    applicationCleanup: application?.cleanupResult ?? null,
  };
  evidence.json('result.json', report);
  process.stdout.write(`${passed}/${expected} Auth acceptance checks passed. ${failed ? 'FAILED' : 'PASS'}\n`);
  for (const failure of evidence.failures) process.stderr.write(`${failure.name}: ${failure.message}\n`);
  process.stdout.write(`Sanitized evidence: ${evidence.output.replace(root + '/', '')}\n`);
  if (failed) process.exitCode = 1;
}
