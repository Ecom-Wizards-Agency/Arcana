import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { buildAuthorityArtifact } from './build.js';

const IMAGE_DIGEST = '7cc56ef285a8568121537d17b05e72128f01b89c54607b51acf084a50ef483f3';
const IMAGE = ['docker.io/library/node:', '22.22.0-bookworm-slim', '@sha256:', IMAGE_DIGEST].join('');

it('verifies real TLS and fixed CA custody through actual broker, worker and readback artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openspell-recommendation-tls.'));
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const revision = 'a'.repeat(40);
  const name = `openspell-recommendation-tls-${process.pid}-${Date.now()}`;
  const openssl = (...args: string[]) => execFileSync('openssl', args, { cwd: root, stdio: 'pipe' });
  try {
    try { execFileSync('docker', ['image', 'inspect', IMAGE], { stdio: 'pipe' }); }
    catch { execFileSync('docker', ['pull', IMAGE], { stdio: 'pipe', timeout: 120_000 }); }
    for (const ca of ['ca', 'wrong-ca']) openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', `/CN=Synthetic ${ca}`, '-addext', 'basicConstraints=critical,CA:TRUE',
      '-keyout', `${ca}.key`, '-out', `${ca}.pem`);
    openssl('req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=tls-db.test',
      '-addext', 'subjectAltName=DNS:tls-db.test', '-addext', 'basicConstraints=critical,CA:FALSE',
      '-keyout', 'server.key', '-out', 'server.csr');
    openssl('x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key',
      '-CAcreateserial', '-days', '1', '-copy_extensions', 'copy', '-out', 'server.pem');
    await buildAuthorityArtifact(revision, join(root, 'broker'), '/usr/local/bin/node');
    execFileSync('bash', [join(repo, 'docs/deploy/build-recommendation-worker-artifact.sh'),
      '--revision', revision, '--output', join(root, 'worker')], { cwd: repo, stdio: 'pipe', timeout: 60_000 });
    const proof = fileURLToPath(new URL('./tls-proof.mjs', import.meta.url));
    const output = execFileSync('docker', ['run', '--rm', '--name', name, '--network', 'none',
      '--add-host', 'tls-db.test:127.0.0.1', '--add-host', 'wrong-db.test:127.0.0.1',
      '--mount', `type=bind,src=${join(root, 'broker')},dst=/broker-stage,readonly`,
      '--mount', `type=bind,src=${join(root, 'worker')},dst=/worker-stage,readonly`,
      '--mount', `type=bind,src=${root},dst=/certificates,readonly`,
      '--mount', `type=bind,src=${proof},dst=/tls-proof.mjs,readonly`,
      '--mount', `type=bind,src=${join(repo, 'docs/deploy/openspell-recommendation-database-trust.mjs')},dst=/trust.mjs,readonly`,
      '--mount', `type=bind,src=${join(repo, 'docs/deploy')},dst=/installation/docs/deploy,readonly`,
      '--tmpfs', '/opt:rw,nosuid,nodev',
      IMAGE, '/usr/local/bin/node', '/tls-proof.mjs',
    ], { encoding: 'utf8', timeout: 90_000, maxBuffer: 32_768 });
    const result: unknown = JSON.parse(output);
    expect(result).toMatchObject({ checks: 41, verifiedStartups: 4, sslRequests: 17,
      authenticationRequests: 0, installerChecks: 7, featureChecks: 2, workerUid: 1000, externalNetwork: false });
    expect((result as { outcomes: unknown[] }).outcomes).toHaveLength(40);
  } finally {
    try { execFileSync('docker', ['rm', '-f', name], { stdio: 'pipe' }); } catch { /* --rm already completed. */ }
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
