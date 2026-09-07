import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertLauncherSystemExecutable, assertRootPath } from './credential.js';

export const RELEASE_ROOT = '/opt/openspell-recommendation-authority/releases';
export const LAUNCHER = '/usr/local/libexec/openspell-recommendation-authority';
export const ARTIFACT_FILES = Object.freeze([
  'ARTIFACT_COUNTS', 'ARTIFACT_SHA256', 'LAUNCHER', 'NODE_PATH', 'REVISION', 'SOURCE_INPUTS', 'broker.mjs', 'verify.mjs',
].sort());
const REVISION = /^[0-9a-f]{40}$/u;

export function launcherText(revision: string, node: string): string {
  if (!REVISION.test(revision) || !/^\/[A-Za-z0-9_./-]+$/u.test(node) || node.includes('/../')) {
    throw new Error('Invalid authority launcher identity');
  }
  return `#!/bin/sh\nexec /usr/bin/env -i LANG=C ${node} ${RELEASE_ROOT}/${revision}/broker.mjs "$@"\n`;
}

/** Staging verifies bytes/counts; installation additionally verifies root custody. */
export async function verifyArtifact(directory: string, revision: string, installed: boolean, verifyLauncher = true): Promise<void> {
  if (!REVISION.test(revision) || (installed && directory !== `${RELEASE_ROOT}/${revision}`)) {
    throw new Error('Invalid authority release identity');
  }
  if (installed) await assertRootPath(directory, 'directory');
  if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(ARTIFACT_FILES)) {
    throw new Error('Authority artifact file census differs');
  }
  for (const name of ARTIFACT_FILES) {
    const file = join(directory, name);
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o7777) !== 0o644
      || metadata.size > 16 * 1024 * 1024) throw new Error('Unsafe authority artifact member');
    if (installed) await assertRootPath(file, 'file');
  }
  const text = (name: string) => readFile(join(directory, name), 'utf8');
  if (await text('REVISION') !== `${revision}\n`
    || await text('ARTIFACT_COUNTS') !== 'directories=1\nfiles=8\nsymlinks=0\n') throw new Error('Authority artifact identity differs');
  const nodeText = await text('NODE_PATH');
  const node = nodeText.trim();
  if (nodeText !== `${node}\n` || await text('LAUNCHER') !== launcherText(revision, node)) {
    throw new Error('Authority launcher differs');
  }
  const hashedFiles = ARTIFACT_FILES.filter((name) => name !== 'ARTIFACT_SHA256');
  const lines = (await text('ARTIFACT_SHA256')).split('\n');
  if (lines.pop() !== '' || lines.length !== hashedFiles.length) throw new Error('Authority checksum census differs');
  for (const [index, name] of hashedFiles.entries()) {
    const digest = createHash('sha256').update(await readFile(join(directory, name))).digest('hex');
    if (lines[index] !== `${digest}  ${name}`) throw new Error('Authority checksum differs');
  }
  const inputs = (await text('SOURCE_INPUTS')).split('\n');
  if (inputs.pop() !== '' || inputs.length < 4
    || inputs.some((line) => (!/^[0-9a-f]{64} {2}[A-Za-z0-9_@+./-]+$/u.test(line)
      && !/^[0-9a-f]{64} {2}node_modules\/\.pnpm\/postgres@3\.4\.9_patch_hash=[0-9a-f]{64}\/node_modules\/postgres\/[A-Za-z0-9_./-]+$/u.test(line))
      || line.includes('/../') || line.slice(66).startsWith('/'))
    || new Set(inputs.map((line) => line.slice(66))).size !== inputs.length) throw new Error('Authority source census differs');
  if (installed) {
    await assertLauncherSystemExecutable('/bin/sh');
    await assertLauncherSystemExecutable('/usr/bin/env');
    await assertRootPath(node, 'file');
    if (((await lstat(node)).mode & 0o7777) !== 0o755) throw new Error('Installed authority runtime differs');
    if (verifyLauncher) {
      await assertRootPath(LAUNCHER, 'file');
      if (((await lstat(LAUNCHER)).mode & 0o7777) !== 0o755
        || await readFile(LAUNCHER, 'utf8') !== await text('LAUNCHER')) throw new Error('Installed authority launcher differs');
    }
  }
}

export async function verifyInstalledLauncher(): Promise<void> {
  await assertRootPath(LAUNCHER, 'file');
  const launcher = await readFile(LAUNCHER, 'utf8');
  const match = launcher.match(/\/opt\/openspell-recommendation-authority\/releases\/([0-9a-f]{40})\/broker\.mjs/u);
  if (!match) throw new Error('Authority launcher identity unavailable');
  await verifyArtifact(`${RELEASE_ROOT}/${match[1]}`, match[1]!, true);
}
