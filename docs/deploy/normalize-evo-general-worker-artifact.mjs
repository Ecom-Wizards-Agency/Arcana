#!/usr/bin/env node

// Normalizes a staged Evo general worker release (WP-326):
//   app/                     pnpm deploy of @wizard-ads/worker, normalized by
//                            normalize-report-worker-evo-artifact.mjs (same package)
//   credential_runtime.py    the systemd credential runtime, mode 0755
//   REVISION                 the full Git object id the release was built from
//   systemd/                 the unit definitions this release was built with
//   wizard-ads-worker.TEMPLATE.json
// It then writes ARTIFACT_LINKS (every symlink and its target) and
// ARTIFACT_SHA256 over every other file in the release, ARTIFACT_LINKS included.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { chmod, lstat, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const [rawReleaseRoot] = process.argv.slice(2);
if (!rawReleaseRoot) {
  process.stderr.write('usage: normalize-evo-general-worker-artifact.mjs <release-root>\n');
  process.exit(2);
}

const releaseRoot = resolve(rawReleaseRoot);
const appNormalizer = join(
  dirname(fileURLToPath(import.meta.url)),
  'normalize-report-worker-evo-artifact.mjs',
);
const expectedRootEntries = [
  'REVISION',
  'app',
  'credential_runtime.py',
  'systemd',
  'wizard-ads-worker.TEMPLATE.json',
];
const expectedUnits = ['wizard-ads-spapi-connections.service', 'wizard-ads-worker.service'];
const requiredAppFiles = [
  'node_modules/tsx/dist/cli.mjs',
  'node_modules/@wizard-ads/sp-api/src/index.ts',
  'src/main.ts',
  'src/spapi-connections-cli.ts',
];

function fail(message) {
  throw new Error(`Evo general worker release ${message}`);
}

const rootEntries = (await readdir(releaseRoot)).sort();
if (JSON.stringify(rootEntries) !== JSON.stringify(expectedRootEntries)) {
  fail('has unexpected root entries');
}
const revision = await readFile(join(releaseRoot, 'REVISION'), 'utf8');
if (!/^[0-9a-f]{40}\n$/u.test(revision)) fail('REVISION is not one full Git object id');
const units = (await readdir(join(releaseRoot, 'systemd'))).sort();
if (JSON.stringify(units) !== JSON.stringify(expectedUnits)) fail('has unexpected unit files');

const normalized = spawnSync(process.execPath, [appNormalizer, join(releaseRoot, 'app')], {
  encoding: 'utf8',
});
if (normalized.status !== 0) {
  process.stderr.write(normalized.stderr);
  fail('app normalization failed');
}
for (const file of requiredAppFiles) {
  const metadata = await lstat(join(releaseRoot, 'app', file)).catch(() => null);
  if (!metadata?.isFile()) fail(`is missing app/${file}`);
}

// Outside app/, the release holds regular files and directories only.
async function normalizeModes(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (path === join(releaseRoot, 'app')) continue;
    const metadata = await lstat(path);
    if (metadata.isDirectory()) {
      await chmod(path, 0o755);
      await normalizeModes(path);
    } else if (metadata.isFile()) {
      await chmod(path, path === join(releaseRoot, 'credential_runtime.py') ? 0o755 : 0o644);
    } else {
      fail('contains a link or special file outside app/');
    }
  }
}
await chmod(releaseRoot, 0o755);
await normalizeModes(releaseRoot);

// Symlinks are not checksummed as files, so their targets are recorded in a
// checksummed manifest (LC_ALL=C order, "path<TAB>target"), as the host verifies
// with: find . -type l -printf '%P\t%l\n' | LC_ALL=C sort | cmp - ARTIFACT_LINKS
const links = [];
async function collectLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) links.push(`${relative(releaseRoot, path)}\t${await readlink(path)}`);
    else if (entry.isDirectory()) await collectLinks(path);
  }
}
await collectLinks(releaseRoot);
const byteOrder = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));
links.sort(byteOrder);
await writeFile(join(releaseRoot, 'ARTIFACT_LINKS'), links.map((line) => `${line}\n`).join(''), {
  mode: 0o644,
});

const files = [];
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile()) files.push(relative(releaseRoot, path));
  }
}
await collect(releaseRoot);
files.sort(byteOrder);
const lines = [];
for (const file of files) {
  const digest = createHash('sha256').update(await readFile(join(releaseRoot, file))).digest('hex');
  lines.push(`${digest}  ./${file}`);
}
if (lines.length !== files.length || lines.length === 0) fail('checksum count does not match its files');
await writeFile(join(releaseRoot, 'ARTIFACT_SHA256'), `${lines.join('\n')}\n`, { mode: 0o644 });

process.stdout.write(
  `normalized ${basename(releaseRoot)} at ${revision.trim()} (${files.length} files checksummed)\n`,
);
