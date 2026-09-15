import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARTIFACT_FILES, launcherText, verifyArtifact } from './artifact.js';
import { buildAuthorityArtifact } from './build.js';
import { assertRootPath, type Metadata } from './credential.js';

describe('immutable authority bundle', () => {
  let root: string; let release: string;
  const revision = 'a'.repeat(40);
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'openspell-authority-test.'));
    release = join(root, 'release');
    await buildAuthorityArtifact(revision, release, await realpath(process.execPath));
  }, 30_000);
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  it('builds a complete standalone artifact with a pinned, cleared-environment launcher', async () => {
    await expect(verifyArtifact(release, revision, false)).resolves.toBeUndefined();
    const launcher = await readFile(join(release, 'LAUNCHER'), 'utf8');
    expect(launcher).toBe(launcherText(revision, await realpath(process.execPath)));
    expect(launcher).toContain('/usr/bin/env -i LANG=C ');
    expect(ARTIFACT_FILES).toHaveLength(8);
    expect(await readFile(join(release, 'SOURCE_INPUTS'), 'utf8')).not.toMatch(/packages\/(db|ads-api)|apps\/worker/u);
    expect(await readFile(join(release, 'SOURCE_INPUTS'), 'utf8')).toContain('docs/deploy/openspell-recommendation-database-trust.mjs');
    expect(await readFile(join(release, 'SOURCE_INPUTS'), 'utf8')).toContain('docs/deploy/install-recommendation-database-ca.sh');
    const patchHash = createHash('sha256').update(await readFile(new URL('../../../patches/postgres@3.4.9.patch', import.meta.url))).digest('hex');
    const inputs = (await readFile(join(release, 'SOURCE_INPUTS'), 'utf8')).trimEnd().split('\n');
    expect(inputs).toContain(`${patchHash}  patches/postgres@3.4.9.patch`);
    expect(inputs.some((line) => line.endsWith('  pnpm-workspace.yaml'))).toBe(true);
    const dependencies = inputs.filter((line) => line.slice(66).startsWith('node_modules/'));
    expect(dependencies.length).toBeGreaterThan(0);
    expect(dependencies.every((line) => line.slice(66).startsWith(
      `node_modules/.pnpm/postgres@3.4.9_patch_hash=${patchHash}/node_modules/postgres/`,
    ))).toBe(true);
  });

  it('refuses changed bytes, extra files, symlinks and writable code', async () => {
    const file = join(release, 'broker.mjs'); const original = await readFile(file);
    await writeFile(file, 'changed');
    await expect(verifyArtifact(release, revision, false)).rejects.toThrow('checksum');
    await writeFile(file, original);
    await chmod(file, 0o664);
    await expect(verifyArtifact(release, revision, false)).rejects.toThrow('Unsafe');
    await chmod(file, 0o644);
    await writeFile(join(release, 'unexpected'), 'extra');
    await expect(verifyArtifact(release, revision, false)).rejects.toThrow('census');
    await rm(join(release, 'unexpected'));
    await rm(file); await symlink(join(release, 'verify.mjs'), file);
    await expect(verifyArtifact(release, revision, false)).rejects.toThrow('Unsafe');
    await rm(file); await writeFile(file, original, { mode: 0o644 });
    await expect(verifyArtifact(release, revision, false)).resolves.toBeUndefined();
    await expect(verifyArtifact(release, revision, true)).rejects.toThrow('identity');
  });
});

describe('root custody across the whole path', () => {
  const file = '/etc/credstore.encrypted/example';
  const metadata = (path: string): Metadata => ({ uid: 0, gid: 0, mode: path === file ? 0o600 : 0o755,
    isFile: () => path === file, isDirectory: () => path !== file, isSymbolicLink: () => false });

  it('checks every ancestor and requires a private regular credential', async () => {
    const paths: string[] = [];
    await assertRootPath(file, 'credential', async (path) => { paths.push(path); return metadata(path); });
    expect(paths).toEqual([file, '/etc/credstore.encrypted', '/etc', '/']);
    for (const bad of [{ uid: 1000 }, { gid: 1000 }, { mode: 0o777 }, { isSymbolicLink: () => true }]) {
      await expect(assertRootPath(file, 'credential', async (path) => ({ ...metadata(path), ...(path === '/etc' ? bad : {}) }))).rejects.toThrow('Unsafe');
    }
    await expect(assertRootPath(file, 'credential', async (path) => ({ ...metadata(path), ...(path === file ? { mode: 0o644 } : {}) }))).rejects.toThrow('Unsafe');
  });
});
