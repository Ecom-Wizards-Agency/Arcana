import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildHostedMigrationBundle } from './bundle.js';
import { buildWithPolicy, canonicalLedger, readGitAdditionsForPolicy, verifyWithPolicy } from './engine.js';
import { HOSTED_MIGRATION_BUNDLE_POLICY, type HostedMigrationBundlePolicy, type MigrationPolicyEntry } from './policy.js';
import { buildWriteWindowBundle, verifyWriteWindowBundle } from './write-window-bundle.js';
import { WRITE_WINDOW_BUNDLE_POLICY } from './write-window-policy.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const roots: string[] = [];

function hash(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function git(repo: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd: repo, encoding: 'utf8' }).trim();
}

async function createFixture(): Promise<{
  root: string;
  repo: string;
  historyWorkdir: string;
  outputWorkdir: string;
  sourceRevision: string;
  repoWorkdir: string;
  policy: HostedMigrationBundlePolicy;
}> {
  const root = await mkdtemp(join(tmpdir(), 'openspell-write-window-test-'));
  roots.push(root);
  const repo = join(root, 'repo');
  const sourceRevision = git(REPO_ROOT, ['rev-parse', 'HEAD']);

  // The engine requires HEAD = origin/main and a clean checkout. Satisfy that
  // requirement only in this disposable, local clone; never alter the working repo.
  git(REPO_ROOT, ['clone', '--quiet', '--shared', '--no-checkout', REPO_ROOT, repo]);
  git(repo, ['sparse-checkout', 'init', '--cone']);
  git(repo, ['sparse-checkout', 'set', 'supabase/migrations']);
  git(repo, ['checkout', '--quiet', '--detach', sourceRevision]);
  git(repo, ['update-ref', 'refs/remotes/origin/main', sourceRevision]);
  vi.spyOn(process, 'cwd').mockReturnValue(repo);

  const historyWorkdir = join(root, 'history');
  const migrations = join(historyWorkdir, 'supabase', 'migrations');
  await mkdir(migrations, { recursive: true });
  const repositoryPaths = git(repo, [
    'ls-tree', '-r', '--name-only', sourceRevision, 'supabase/migrations',
  ]).split('\n');
  const syntheticBaseline: MigrationPolicyEntry[] = [];
  for (const expected of WRITE_WINDOW_BUNDLE_POLICY.baseline) {
    // Use the hosted filenames with committed repository SQL as synthetic inputs.
    // Several historical hosted statements differ from today's source bytes.
    // This fixture must therefore never be mistaken for the hosted baseline.
    const suffix = expected.filename.replace(/^(?:\d{14}_)+/u, '');
    const candidates = repositoryPaths.filter((path) =>
      path.slice(path.lastIndexOf('/') + 1).replace(/^(?:\d{14}_)+/u, '') === suffix,
    );
    expect(candidates).toHaveLength(1);
    const bytes = execFileSync('git', ['cat-file', 'blob', `${sourceRevision}:${candidates[0]!}`], {
      cwd: repo,
    });
    syntheticBaseline.push({
      filename: expected.filename,
      byteCount: bytes.byteLength,
      sha256: hash(bytes),
    });
    await writeFile(join(migrations, expected.filename), bytes);
  }
  expect(await readdir(migrations)).toHaveLength(46);
  const syntheticAll = [...syntheticBaseline, ...WRITE_WINDOW_BUNDLE_POLICY.additions];
  const policy: HostedMigrationBundlePolicy = {
    ...WRITE_WINDOW_BUNDLE_POLICY,
    baseline: syntheticBaseline,
    baselineByteCount: syntheticBaseline.reduce((sum, entry) => sum + entry.byteCount, 0),
    baselineLedgerSha256: hash(canonicalLedger(syntheticBaseline)),
    bundleByteCount: syntheticAll.reduce((sum, entry) => sum + entry.byteCount, 0),
    bundleLedgerSha256: hash(canonicalLedger(syntheticAll)),
  };
  return {
    root,
    repo,
    historyWorkdir,
    outputWorkdir: join(root, 'bundle'),
    sourceRevision,
    repoWorkdir: repo,
    policy,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('second manual write window', () => {
  it('pins the completed first window and exact ten reviewed additions independently', () => {
    const policy = WRITE_WINDOW_BUNDLE_POLICY;
    const all = [...policy.baseline, ...policy.additions];
    expect(policy.baseline).toEqual([
      ...HOSTED_MIGRATION_BUNDLE_POLICY.baseline,
      ...HOSTED_MIGRATION_BUNDLE_POLICY.additions.map(({ filename, byteCount, sha256 }) =>
        ({ filename, byteCount, sha256 }),
      ),
    ]);
    expect(policy.baseline).toHaveLength(46);
    expect(policy.additions).toHaveLength(10);
    expect(policy.baseline.reduce((sum, entry) => sum + entry.byteCount, 0)).toBe(646_628);
    expect(all.reduce((sum, entry) => sum + entry.byteCount, 0)).toBe(895_200);
    expect(hash(canonicalLedger(policy.baseline))).toBe(policy.baselineLedgerSha256);
    expect(hash(canonicalLedger(all))).toBe(policy.bundleLedgerSha256);
    expect(policy.baseline.at(-1)?.filename.slice(0, 14)).toBe('20260901060000');
    expect(policy.additions.at(-1)?.filename.slice(0, 14)).toBe('20260906040000');
    expect(policy.additions.map((entry) => entry.workPackage)).toEqual([
      'WP-214', 'WP-214', 'WP-214', 'WP-214', 'WP-214',
      'WP-217', 'WP-217', 'WP-217', 'WP-217', 'WP-217',
    ]);
    expect(HOSTED_MIGRATION_BUNDLE_POLICY.baseline).toHaveLength(41);
    expect(HOSTED_MIGRATION_BUNDLE_POLICY.additions).toHaveLength(5);
    expect(HOSTED_MIGRATION_BUNDLE_POLICY.bundleByteCount).toBe(646_628);
  });

  it('builds and independently verifies 56 files with a synthetic baseline and the pinned additions', async () => {
    const fixture = await createFixture();
    const evidence = await buildWithPolicy(fixture);
    expect(evidence).toMatchObject({
      status: 'verified',
      artifactMode: 'sealed',
      sourceRevision: fixture.sourceRevision,
      baselineFiles: 46,
      addedFiles: 10,
      totalFiles: 56,
      totalBytes: fixture.policy.bundleByteCount,
      lastVersion: '20260906040000',
      baselineLedgerSha256: fixture.policy.baselineLedgerSha256,
      bundleLedgerSha256: fixture.policy.bundleLedgerSha256,
    });
    const migrations = join(fixture.outputWorkdir, 'supabase', 'migrations');
    const entries = [...fixture.policy.baseline, ...fixture.policy.additions];
    expect((await readdir(migrations)).sort()).toEqual(entries.map((entry) => entry.filename));
    for (const entry of entries) {
      const bytes = await readFile(join(migrations, entry.filename));
      expect(bytes.byteLength).toBe(entry.byteCount);
      expect(hash(bytes)).toBe(entry.sha256);
    }
    const manifestBytes = await readFile(join(fixture.outputWorkdir, 'BUNDLE_MANIFEST.json'));
    expect(hash(manifestBytes)).toBe(evidence.manifestSha256);
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
      purpose: string;
      migrations: { provenance: string }[];
    };
    expect(manifest.purpose).toBe('construction_and_review_only');
    expect(manifest.migrations.filter((entry) => entry.provenance === 'hosted_baseline')).toHaveLength(46);
    expect(manifest.migrations.filter((entry) => entry.provenance === 'reviewed_git_blob')).toHaveLength(10);
    await expect(verifyWithPolicy({
      ...fixture,
      bundleWorkdir: fixture.outputWorkdir,
      sourceRevision: fixture.sourceRevision,
      mode: 'sealed',
    })).resolves.toEqual(evidence);
  });

  it('keeps both public builders from treating synthetic repository history as the hosted baseline', async () => {
    const fixture = await createFixture();
    await expect(buildWriteWindowBundle(fixture)).rejects.toMatchObject({ code: 'BASELINE_POLICY' });
    await buildWithPolicy(fixture);
    await expect(verifyWriteWindowBundle({
      bundleWorkdir: fixture.outputWorkdir,
      sourceRevision: fixture.sourceRevision,
      mode: 'sealed',
    })).rejects.toMatchObject({ code: 'ARTIFACT_POLICY' });
    for (const entry of HOSTED_MIGRATION_BUNDLE_POLICY.additions) {
      await rm(join(fixture.historyWorkdir, 'supabase', 'migrations', entry.filename));
    }
    await expect(buildHostedMigrationBundle({
      ...fixture,
      outputWorkdir: join(fixture.root, 'invalid-first-window'),
    })).rejects.toMatchObject({ code: 'BASELINE_POLICY' });
  });

  it('checks all ten committed additions against the fixed production policy', async () => {
    const fixture = await createFixture();
    const additions = await readGitAdditionsForPolicy(
      fixture.repo,
      fixture.sourceRevision,
      WRITE_WINDOW_BUNDLE_POLICY,
    );
    expect(additions).toHaveLength(10);
    expect(additions.map(({ filename, byteCount, sha256 }) => ({ filename, byteCount, sha256 }))).toEqual(
      WRITE_WINDOW_BUNDLE_POLICY.additions.map(({ filename, byteCount, sha256 }) => ({ filename, byteCount, sha256 })),
    );
  });

  it.each(['changed', 'missing', 'extra'] as const)('refuses a %s baseline file', async (mutation) => {
    const fixture = await createFixture();
    const migrations = join(fixture.historyWorkdir, 'supabase', 'migrations');
    const baseline = join(migrations, WRITE_WINDOW_BUNDLE_POLICY.baseline.at(-1)!.filename);
    if (mutation === 'changed') await writeFile(baseline, 'select 0;\n');
    if (mutation === 'missing') await rm(baseline);
    if (mutation === 'extra') await writeFile(join(migrations, '20260902000000_unreviewed.sql'), 'select 0;\n');
    await expect(buildWithPolicy(fixture)).rejects.toMatchObject({ code: 'BASELINE_POLICY' });
  });

  it.each(['changed baseline', 'changed addition', 'missing addition', 'extra file'] as const)(
    'refuses a sealed bundle with a %s',
    async (mutation) => {
      const fixture = await createFixture();
      await buildWithPolicy(fixture);
      const migrations = join(fixture.outputWorkdir, 'supabase', 'migrations');
      const baseline = join(migrations, WRITE_WINDOW_BUNDLE_POLICY.baseline.at(-1)!.filename);
      const addition = join(migrations, WRITE_WINDOW_BUNDLE_POLICY.additions[0]!.filename);
      if (mutation === 'changed baseline') await writeFile(baseline, 'select 0;\n');
      if (mutation === 'changed addition') await writeFile(addition, 'select 0;\n');
      if (mutation === 'missing addition') await rm(addition);
      if (mutation === 'extra file') await writeFile(join(migrations, '20260907000000_unreviewed.sql'), 'select 0;\n');
      await expect(verifyWithPolicy({
        ...fixture,
        bundleWorkdir: fixture.outputWorkdir,
        sourceRevision: fixture.sourceRevision,
        mode: 'sealed',
      })).rejects.toMatchObject({ code: 'ARTIFACT_POLICY' });
    },
  );

  it('refuses changed committed additions instead of trusting their new digest', async () => {
    const fixture = await createFixture();
    const addition = WRITE_WINDOW_BUNDLE_POLICY.additions[0]!;
    await writeFile(join(fixture.repo, addition.repositoryPath), 'select 0;\n');
    git(fixture.repo, ['add', addition.repositoryPath]);
    git(fixture.repo, [
      '-c', 'user.name=Write Window Test', '-c', 'user.email=write-window@example.invalid',
      'commit', '--quiet', '-m', 'unreviewed migration fixture',
    ]);
    const sourceRevision = git(fixture.repo, ['rev-parse', 'HEAD']);
    git(fixture.repo, ['update-ref', 'refs/remotes/origin/main', sourceRevision]);
    await expect(buildWithPolicy({ ...fixture, sourceRevision })).rejects.toMatchObject({
      code: 'SOURCE_POLICY',
    });
  });
});
