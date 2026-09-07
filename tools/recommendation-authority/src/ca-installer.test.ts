import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
const source = fileURLToPath(new URL('../../../docs/deploy/', import.meta.url));

it.each(['dirty', 'origin', 'digest', 'pem'] as const)('refuses %s CA installation before privilege in an actual Git checkout', async (scenario) => {
  const root = await mkdtemp(join(tmpdir(), 'openspell-ca-source.'));
  try {
    const repo = join(root, 'repo');
    const deploy = join(repo, 'docs/deploy');
    const bin = join(root, 'bin');
    await mkdir(deploy, { recursive: true }); await mkdir(bin);
    for (const name of ['install-recommendation-database-ca.sh',
      'openspell-recommendation-database-trust.mjs', 'recommendation-worker-evo-systemd-lib.sh']) {
      await cp(join(source, name), join(deploy, name));
    }
    const env = { PATH: `${bin}:${process.env['PATH'] ?? ''}`, GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', CA_PROOF_MARKER: join(root, 'privileged') };
    const git = (...args: string[]) => execute('git', ['-C', repo, ...args], { env });
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.name', 'Synthetic CA proof');
    await git('config', 'user.email', 'proof@example.test');
    await git('config', 'core.hooksPath', join(root, 'no-hooks'));
    await git('add', '.'); await git('commit', '-qm', 'Synthetic reviewed source');
    const revision = (await git('rev-parse', 'HEAD')).stdout.trim();
    await git('update-ref', 'refs/remotes/origin/main', revision);
    if (scenario === 'dirty') await writeFile(join(repo, 'unreviewed'), 'changed');
    if (scenario === 'origin') {
      await git('commit', '--allow-empty', '-qm', 'Synthetic remote movement');
      await git('update-ref', 'refs/remotes/origin/main', (await git('rev-parse', 'HEAD')).stdout.trim());
      await git('reset', '--hard', revision);
    }
    await writeFile(join(bin, 'sudo'), '#!/bin/sh\nprintf attempted >> "$CA_PROOF_MARKER"\nexit 91\n', { mode: 0o755 });
    const input = 'synthetic malformed certificate';
    await writeFile(join(root, 'input.pem'), input);
    const digest = scenario === 'digest' ? '0'.repeat(64) : createHash('sha256').update(input).digest('hex');
    let status = 0; let stderr = '';
    try {
      await execute('bash', [join(deploy, 'install-recommendation-database-ca.sh'), '--revision', revision,
        '--certificate', join(root, 'input.pem'), '--sha256', digest], { env, timeout: 10_000 });
    } catch (error) {
      ({ code: status, stderr } = error as { code: number; stderr: string });
    }
    expect(status).toBe(1);
    expect(stderr).toContain(scenario === 'dirty' || scenario === 'origin'
      ? 'source must be clean exact approved main' : scenario === 'digest' ? 'input digest differs' : 'CA is invalid');
    await expect(readFile(join(root, 'privileged'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
