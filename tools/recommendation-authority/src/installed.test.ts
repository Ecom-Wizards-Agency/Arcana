import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { buildAuthorityArtifact } from './build.js';

const IMAGE_DIGEST = '7cc56ef285a8568121537d17b05e72128f01b89c54607b51acf084a50ef483f3';
const IMAGE = ['docker.io/library/node:', '22.22.0-bookworm-slim', '@sha256:', IMAGE_DIGEST].join('');

it('executes the immutable root launcher in a disposable networkless container', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openspell-authority-installed.'));
  const revision = 'a'.repeat(40);
  const name = `openspell-authority-proof-${process.pid}-${Date.now()}`;
  try {
    try { execFileSync('docker', ['image', 'inspect', IMAGE], { stdio: 'pipe' }); }
    catch { execFileSync('docker', ['pull', IMAGE], { stdio: 'pipe', timeout: 120_000 }); }
    await buildAuthorityArtifact(revision, join(root, 'release'), '/usr/local/bin/node');
    const proof = fileURLToPath(new URL('./installed-proof.mjs', import.meta.url));
    const output = execFileSync('docker', ['run', '--rm', '--name', name, '--network', 'none',
      '--mount', `type=bind,src=${join(root, 'release')},dst=/stage,readonly`,
      '--mount', `type=bind,src=${proof},dst=/installed-proof.mjs,readonly`,
      '--tmpfs', '/proof:rw,nosuid,nodev', '--tmpfs', '/opt:rw,nosuid,nodev',
      IMAGE, '/usr/local/bin/node', '/installed-proof.mjs',
    ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 16_384 });
    expect(JSON.parse(output)).toEqual({ checks: 10, files: 8, decryptCalls: 1, injectionExecutions: 0, externalNetwork: false });
  } finally {
    try { execFileSync('docker', ['rm', '-f', name], { stdio: 'pipe' }); } catch { /* --rm already completed. */ }
    await rm(root, { recursive: true, force: true });
  }
}, 150_000);
