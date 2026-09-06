#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { pathToFileURL } from 'node:url';

const MAX_INPUT_BYTES = 8_192;
import { parseCutoverEvidence, parseAuthorityTuple, expectedTransition, classifyTransitionReadback, parseBrokerResult, validateCutoverEvidence } from './openspell-recommendation-authority-contract.mjs';
export { parseAuthorityTuple, expectedTransition, classifyTransitionReadback, parseBrokerResult, validateCutoverEvidence } from './openspell-recommendation-authority-contract.mjs';
const REVISION = /^[0-9a-f]{40}$/u;
async function readAuthority(databaseUrl, revision) {
  const { RecommendationWorkerDatabase } = await import('@wizard-ads/db/recommendation-worker');
  const database = new RecommendationWorkerDatabase({
    connectionString: databaseUrl,
    workerId: 'evo-recommendation-worker',
    revision,
    statementTimeoutSeconds: 5,
  });
  try {
    return parseAuthorityTuple(await database.getAuthority());
  } finally {
    await database.close();
  }
}

async function readCutoverEvidence(databaseUrl, revision) {
  const { RecommendationWorkerDatabase } = await import('@wizard-ads/db/recommendation-worker');
  const database = new RecommendationWorkerDatabase({
    connectionString: databaseUrl,
    workerId: 'evo-recommendation-worker',
    revision,
    statementTimeoutSeconds: 5,
  });
  try {
    return parseCutoverEvidence(await database.getCutoverEvidence());
  } finally {
    await database.close();
  }
}

async function runCommand() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === '--verify-broker' && args.length === 0) {
    // Bundled into the immutable worker deployment helper, with no broker
    // credential loader invocation or authority database connection.
    const { verifyInstalledLauncher } = await import('../../tools/recommendation-authority/src/artifact.ts');
    await verifyInstalledLauncher();
    return;
  }
  if (mode === '--read') {
    const [revision] = args;
    if (!REVISION.test(revision ?? '')) throw new Error('authority readback failed');
    const databaseUrl = (await boundedStdin()).trim();
    const authority = await readAuthority(databaseUrl, revision);
    process.stdout.write(`${JSON.stringify(authority)}\n`);
    return;
  }
  if (mode === '--evidence') {
    const [revision] = args;
    if (!REVISION.test(revision ?? '')) throw new Error('evidence readback failed');
    const databaseUrl = (await boundedStdin()).trim();
    const evidence = await readCutoverEvidence(databaseUrl, revision);
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
    return;
  }
  if (mode === '--expected') {
    const [operation, rawOld, revision] = args;
    const expected = expectedTransition(operation, JSON.parse(rawOld), revision);
    process.stdout.write(`${JSON.stringify(expected)}\n`);
    return;
  }
  if (mode === '--classify') {
    const [rawOld, rawNew] = args;
    const actual = JSON.parse(await boundedStdin());
    const decision = classifyTransitionReadback(JSON.parse(rawOld), JSON.parse(rawNew), actual);
    process.stdout.write(`${decision}\n`);
    if (decision === 'ambiguous') process.exitCode = 78;
    return;
  }
  if (mode === '--validate-broker') {
    const [operation] = args;
    parseBrokerResult(JSON.parse(await boundedStdin()), operation);
    return;
  }
  if (mode === '--validate-evidence') {
    const [phase, revision] = args;
    validateCutoverEvidence(JSON.parse(await boundedStdin()), phase, revision);
    return;
  }
  throw new Error('authority command is invalid');
}

async function boundedStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.byteLength;
    if (bytes > MAX_INPUT_BYTES) throw new Error('authority input is invalid');
    chunks.push(Buffer.from(chunk));
  }
  if (bytes === 0) {
    throw new Error('authority input is invalid');
  }
  return Buffer.concat(chunks, bytes).toString('utf8');
}


if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Each readback attempt must finish even if the transport loses a response
  // while leaving its socket open. Deadline failure remains unknown authority.
  const deadline = setTimeout(() => {
    process.stderr.write('OpenSpell recommendation authority operation failed\n');
    process.exit(78);
  }, 15_000);
  runCommand().catch(() => {
    process.stderr.write('OpenSpell recommendation authority operation failed\n');
    process.exitCode = 1;
  }).finally(() => clearTimeout(deadline));
}
