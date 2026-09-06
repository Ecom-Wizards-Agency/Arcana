import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** Actual installer, owned Git checkout and command stubs; sudo never executes. */
async function installation(caseName: 'head' | 'origin' | 'inputs' | 'unchanged') {
  const root = await mkdtemp(join(tmpdir(), 'openspell-installer-review.'));
  try {
    const repo = join(root, 'checkout');
    const scripts = join(repo, 'docs/deploy');
    const bin = join(root, 'bin');
    await mkdir(scripts, { recursive: true });
    await mkdir(bin);
    const sources = ['docs/deploy/install-recommendation-authority.sh',
      'docs/deploy/recommendation-worker-evo-systemd-lib.sh',
      'source-a.txt', 'source-b.txt'];
    for (const path of sources.slice(0, 2)) await cp(join(sourceRoot, path), join(repo, path));
    for (const path of sources.slice(2)) await writeFile(join(repo, path), 'Synthetic approved source\n');
    const env = { PATH: process.env['PATH'] ?? '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      REVIEW_CASE: caseName, REVIEW_NODE: process.execPath, REVIEW_BIN: bin, REVIEW_MARKER: join(root, 'privileged') };
    const git = (...args: string[]) => execute('git', ['-C', repo, ...args], { env });
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.name', 'Synthetic installation review');
    await git('config', 'user.email', 'review@example.test');
    await git('config', 'core.hooksPath', join(root, 'no-hooks'));
    await git('add', '.');
    await git('commit', '-qm', 'Synthetic approved revision');
    const revision = (await git('rev-parse', 'HEAD')).stdout.trim();
    await git('update-ref', 'refs/remotes/origin/main', revision);
    const lines = await Promise.all(sources.map(async (path) =>
      `${createHash('sha256').update(await readFile(join(repo, path))).digest('hex')}  ${path}`));
    if (caseName === 'inputs') lines[2] = `${'0'.repeat(64)}  ${sources[2]}`;
    await writeFile(join(bin, 'SOURCE_INPUTS'), `${lines.join('\n')}\n`);
    const stubs = {
      pnpm: `#!/bin/bash
if [[ "$3" == install ]]; then
  if [[ "$REVIEW_CASE" == head ]]; then
    git -C "$2" commit --allow-empty -qm 'Synthetic concurrent clean revision'
  elif [[ "$REVIEW_CASE" == origin ]]; then
    tree="$(git -C "$2" rev-parse 'HEAD^{tree}')"
    moved="$(git -C "$2" commit-tree "$tree" -p HEAD -m 'Synthetic remote movement')"
    git -C "$2" update-ref refs/remotes/origin/main "$moved"
  fi
else
  mkdir "$7"
  cp "$REVIEW_BIN/SOURCE_INPUTS" "$7/SOURCE_INPUTS"
fi
`,
      readlink: '#!/bin/sh\nprintf "%s\\n" "$REVIEW_NODE"\n',
      sudo: '#!/bin/sh\nprintf "%s\\n" "$1" >> "$REVIEW_MARKER"\n[ "$1" != test ] || exit 1\nexit 91\n',
      rsync: '#!/bin/sh\nexit 92\n',
    };
    for (const [name, contents] of Object.entries(stubs)) {
      await writeFile(join(bin, name), contents);
      await chmod(join(bin, name), 0o755);
    }
    let status = 0, stderr = '';
    try {
      await execute('bash', [join(scripts, 'install-recommendation-authority.sh'), '--revision', revision], {
        env: { ...env, PATH: `${bin}:${env.PATH}` }, timeout: 15_000,
      });
    } catch (error) {
      const result = error as { code: number; stderr: string };
      status = result.code; stderr = result.stderr;
    }
    const privileged = await readFile(join(root, 'privileged'), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    return { status, stderr, privileged,
      clean: (await git('status', '--porcelain')).stdout === '',
      headChanged: (await git('rev-parse', 'HEAD')).stdout.trim() !== revision,
      originChanged: (await git('rev-parse', 'refs/remotes/origin/main')).stdout.trim() !== revision };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

it.each(['head', 'origin'] as const)('refuses a different clean %s revision after building, before any privileged call', async (change) => {
  const result = await installation(change);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('source revision changed during build');
  expect(result.clean).toBe(true);
  expect(change === 'head' ? result.headChanged : result.originChanged).toBe(true);
  expect(result.privileged).toBe('');
});

it('compares compiled source hashes with the approved Git object before privileged work', async () => {
  const result = await installation('inputs');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('compiled source differs from approved Git revision');
  expect(result.clean).toBe(true);
  expect(result.headChanged || result.originChanged).toBe(false);
  expect(result.privileged).toBe('');
});

it('lets unchanged exact source reach only the mocked privilege barrier', async () => {
  const result = await installation('unchanged');
  expect(result.status).toBe(91);
  expect(result.privileged).toBe('test\ntest\ntouch\n');
  expect(result.clean).toBe(true);
});
