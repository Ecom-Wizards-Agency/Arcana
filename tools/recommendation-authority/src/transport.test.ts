import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createTestDatabase, databaseAvailable } from '@wizard-ads/db/testing';
import { expect, it } from 'vitest';
import { classifyTransitionReadback, expectedTransition } from '../../../docs/deploy/openspell-recommendation-authority-contract.mjs';
import { buildAuthorityArtifact } from './build.js';

const execute = promisify(execFile);
const IMAGE_DIGEST = '7cc56ef285a8568121537d17b05e72128f01b89c54607b51acf084a50ef483f3';
const IMAGE = ['docker.io/library/node:', '22.22.0-bookworm-slim', '@sha256:', IMAGE_DIGEST].join('');
const available = await databaseAvailable();

// Only the encrypted-secret fixture is substituted. The compiled broker,
// launcher, integrity checks, driver, SQL and 15-second deadline are unchanged.
// A networkless container reaches only our Unix-socket bridge to a throwaway DB.
const fixture = String.raw`
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, chown, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
const revision = 'a'.repeat(40);
const root = '/opt/openspell-recommendation-authority/releases/' + revision;
const launcher = '/usr/local/libexec/openspell-recommendation-authority';
const credential = '/etc/credstore.encrypted/openspell-recommendation-authority-database-url';
const sockets = new Set();
const forwarder = net.createServer(client => {
  const upstream = net.connect('/bridge/database.sock');
  for (const socket of [client, upstream]) { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); }
  client.pipe(upstream); upstream.pipe(client);
  client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy());
});
try {
  await new Promise(resolve => forwarder.listen(0, '127.0.0.1', resolve));
  const url = new URL((await readFile('/fixture/database-url', 'utf8')).trim());
  url.hostname = '127.0.0.1'; url.port = String(forwarder.address().port); url.search = '';
  await mkdir(root, { recursive: true, mode: 0o755 });
  await cp('/stage', root, { recursive: true });
  for (const name of await readdir(root)) { await chown(root + '/' + name, 0, 0); await chmod(root + '/' + name, 0o644); }
  await mkdir('/usr/local/libexec', { recursive: true, mode: 0o755 });
  await writeFile(launcher, await readFile(root + '/LAUNCHER'), { mode: 0o755 });
  await mkdir('/etc/credstore.encrypted', { recursive: true, mode: 0o755 });
  await writeFile(credential, 'synthetic encrypted fixture', { mode: 0o600 });
  await writeFile('/proof/database-url', url.toString(), { mode: 0o600 });
  await writeFile('/usr/bin/systemd-creds', '#!/bin/sh\nprintf "decrypt\\n" >> /proof/decrypt-calls\nexec /bin/cat /proof/database-url\n', { mode: 0o755 });
  const started = Date.now();
  const child = spawn(launcher, ['block', '0', '-', revision], { env: { LANG: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  const elapsedMs = Date.now() - started;
  assert.equal(status, 1);
  assert.equal(stdout, '');
  assert.equal(stderr, 'OpenSpell recommendation authority operation could not be confirmed\n');
  assert.equal(await readFile('/proof/decrypt-calls', 'utf8'), 'decrypt\n');
  assert.ok(elapsedMs >= 14000 && elapsedMs < 20000);
  process.stdout.write(JSON.stringify({ status, elapsedMs, stdoutBytes: 0, fixedFailure: true, decryptCalls: 1 }));
} catch {
  process.stderr.write('Synthetic authority transport fixture failed\n'); process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => forwarder.close(resolve));
}
`;

it.skipIf(!available)('bounds the actual installed broker after one committed CAS loses its COMMIT acknowledgement', async () => {
  const database = await createTestDatabase('authority_transport', { applyFixture: false });
  const root = await mkdtemp(join(tmpdir(), 'openspell-authority-transport.'));
  const name = `openspell-authority-transport-${process.pid}-${Date.now()}`;
  const sockets = new Set<net.Socket>();
  let casRequests = 0, commitRequests = 0, droppedResponseBytes = 0;
  const upstreamUrl = new URL(database.connectionString);
  expect(['127.0.0.1', 'localhost', '[::1]']).toContain(upstreamUrl.hostname);
  const bridge = net.createServer((client) => {
    const upstream = net.connect({ host: upstreamUrl.hostname, port: Number(upstreamUrl.port || '5432') });
    let buffer = Buffer.alloc(0), startup = true, drop = false;
    for (const socket of [client, upstream]) {
      sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    }
    client.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      for (;;) {
        if (buffer.length < (startup ? 4 : 5)) break;
        const length = buffer.readInt32BE(startup ? 0 : 1) + (startup ? 0 : 1);
        if (length < 4 || length > 1024 * 1024) { client.destroy(); upstream.destroy(); break; }
        if (buffer.length < length) break;
        if (!startup) {
          const tag = String.fromCharCode(buffer[0]!);
          const fields = buffer.subarray(5, length).toString('utf8').split('\0');
          const statement = tag === 'Q' ? fields[0] : tag === 'P' ? fields[1] : undefined;
          if (statement?.includes('public.block_recommendation_admission(')) casRequests += 1;
          if (statement?.trim().toLowerCase() === 'commit') { commitRequests += 1; drop = true; }
        }
        startup = false; buffer = buffer.subarray(length);
      }
      upstream.write(data);
    });
    upstream.on('data', (data: Buffer) => {
      if (drop) droppedResponseBytes += data.length;
      else client.write(data);
    });
    client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy());
  });
  try {
    try { await execute('docker', ['image', 'inspect', IMAGE]); }
    catch { await execute('docker', ['pull', IMAGE], { timeout: 120_000 }); }
    const revision = 'a'.repeat(40);
    await buildAuthorityArtifact(revision, join(root, 'release'), '/usr/local/bin/node');
    await mkdir(join(root, 'bridge'));
    await mkdir(join(root, 'fixture'));
    await writeFile(join(root, 'fixture', 'database-url'), database.connectionString, { mode: 0o600 });
    await writeFile(join(root, 'fixture', 'run.mjs'), fixture);
    await new Promise<void>((resolve, reject) => {
      bridge.once('error', reject); bridge.listen(join(root, 'bridge', 'database.sock'), resolve);
    });
    await chmod(join(root, 'bridge', 'database.sock'), 0o600);
    const output = await execute('docker', ['run', '--rm', '--name', name, '--network', 'none',
      '--mount', `type=bind,src=${join(root, 'release')},dst=/stage,readonly`,
      '--mount', `type=bind,src=${join(root, 'fixture')},dst=/fixture,readonly`,
      '--mount', `type=bind,src=${join(root, 'bridge')},dst=/bridge,readonly`,
      '--tmpfs', '/proof:rw,nosuid,nodev', '--tmpfs', '/opt:rw,nosuid,nodev',
      IMAGE, '/usr/local/bin/node', '/fixture/run.mjs',
    ], { timeout: 25_000, maxBuffer: 16_384 });
    expect(JSON.parse(output.stdout)).toMatchObject({ status: 1, stdoutBytes: 0, fixedFailure: true, decryptCalls: 1 });
    expect(output.stderr).toBe('');
    expect(casRequests).toBe(1);
    expect(commitRequests).toBe(1);
    expect(droppedResponseBytes).toBeGreaterThan(0);
    const rows = await database.sql`
      select protocol,admission,epoch::int,authorized_revision as "authorizedRevision"
        from app.recommendation_claim_authority
    `;
    expect(rows).toEqual([{ protocol: 'legacy', admission: 'blocked', epoch: 1, authorizedRevision: null }]);
    const old = { protocol: 'legacy', admission: 'legacy', epoch: 0, authorizedRevision: null };
    expect(classifyTransitionReadback(old, expectedTransition('block', old, revision), rows[0])).toBe('committed');
  } finally {
    await execute('docker', ['rm', '-f', name]).catch(() => {});
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => bridge.close(() => resolve()));
    await database.drop();
    await rm(root, { recursive: true, force: true });
  }
}, 150_000);
