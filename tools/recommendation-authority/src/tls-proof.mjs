import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, chown, cp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import tls from 'node:tls';
import { initializeRecommendationDatabaseTrust, RECOMMENDATION_DATABASE_CA } from '/trust.mjs';

// Owned networkless container. Real TLS and PostgreSQL SSLRequest/Startup; the
// synthetic server refuses authentication after counting verified connections.
const revision = 'a'.repeat(40);
const authority = `/opt/openspell-recommendation-authority/releases/${revision}`;
const worker = '/opt/worker/bin';
const launcher = '/usr/local/libexec/openspell-recommendation-authority';
const pem = await readFile('/certificates/ca.pem', 'utf8');
await mkdir(authority, { recursive: true, mode: 0o755 });
await cp('/broker-stage', authority, { recursive: true });
for (const file of await readdir(authority)) {
  await chown(`${authority}/${file}`, 0, 0);
  await chmod(`${authority}/${file}`, 0o644);
}
await mkdir('/opt/worker', { recursive: true });
await cp('/worker-stage', '/opt/worker', { recursive: true });
await mkdir('/usr/local/libexec', { recursive: true });
await writeFile(launcher, await readFile(`${authority}/LAUNCHER`), { mode: 0o755 });
await mkdir('/etc/credstore.encrypted', { recursive: true });
await writeFile('/etc/credstore.encrypted/openspell-recommendation-authority-database-url', 'synthetic', { mode: 0o600 });
await mkdir('/etc/openspell', { mode: 0o755 });
const defaults = tls.getCACertificates('default');
initializeRecommendationDatabaseTrust('postgres://synthetic:synthetic@tls-db.test/disposable', {});
assert.deepEqual(tls.getCACertificates('default'), defaults);
let checks = 1;
let startups = 0;
let sslRequests = 0;
const sockets = new Set();
const context = tls.createSecureContext({
  cert: await readFile('/certificates/server.pem'), key: await readFile('/certificates/server.key'),
});
const server = net.createServer((socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => {});
  socket.once('data', (packet) => {
    assert.equal(packet.length, 8);
    assert.equal(packet.readInt32BE(0), 8);
    assert.equal(packet.readInt32BE(4), 80877103);
    sslRequests += 1;
    socket.write('S');
    const secure = new tls.TLSSocket(socket, { isServer: true, secureContext: context });
    secure.on('error', () => {});
    secure.once('data', (startup) => {
      assert.equal(startup.readInt32BE(4), 196608);
      assert.equal(startup.readInt32BE(0), startup.length);
      startups += 1;
      const message = Buffer.from('SFATAL\0C28000\0Msynthetic TLS proof stops before authentication\0\0');
      const length = Buffer.alloc(4); length.writeInt32BE(message.length + 4);
      secure.end(Buffer.concat([Buffer.from('E'), length, message]));
    });
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const config = Object.fromEntries((await readFile('/opt/worker/public-standby.conf', 'utf8'))
  .trim().split('\n').map((line) => line.split('=')));
const outcomes = [];

async function child(command, args, env, input = '', unprivileged = false) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'],
      ...(unprivileged ? { uid: 1000, gid: 1000 } : {}) });
    const timer = setTimeout(() => { process.kill('SIGKILL'); reject(new Error('TLS child deadline exceeded')); }, 10_000);
    let stdout = ''; let stderr = '';
    process.stdout.on('data', (data) => { stdout += data; });
    process.stderr.on('data', (data) => { stderr += data; });
    process.on('error', reject);
    process.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    process.stdin.end(input);
  });
}
async function invoke(caller, label, expectedStartups, { host = 'tls-db.test', query = 'sslmode=verify-full', env = {} } = {}) {
  const url = `postgres://synthetic:synthetic@${host}:${port}/disposable?${query}`;
  await writeFile('/usr/bin/systemd-creds', `#!/bin/sh\nprintf '%s' '${url}'\n`, { mode: 0o755 });
  const before = startups;
  const beforeSsl = sslRequests;
  const result = caller === 'broker'
    ? await child(launcher, ['block', '0', '-', revision], env)
    : caller === 'worker'
      ? await child('/usr/local/bin/node', [`${worker}/openspell-recommendation-worker-runtime.mjs`], { ...config, DATABASE_URL: url, ...env }, '', true)
      : await child('/usr/local/bin/node', [`${worker}/openspell-recommendation-worker-authority.mjs`, caller, revision], env, url);
  assert.equal(result.status, 1, `${caller}/${label}: bounded failure after TLS or at refusal`);
  assert.equal(result.stdout, '', `${caller}/${label}: no credential output`);
  assert(!result.stderr.includes(url));
  assert.equal(startups - before, expectedStartups, `${caller}/${label}: verified PostgreSQL Startup count; SSLRequests=${sslRequests - beforeSsl}; ${result.stderr}`);
  outcomes.push({ caller, label, startups: startups - before, sslRequests: sslRequests - beforeSsl });
  checks += 1;
}
async function correctCa() {
  await rm(RECOMMENDATION_DATABASE_CA, { force: true });
  await writeFile(RECOMMENDATION_DATABASE_CA, pem, { mode: 0o644 });
}
try {
  const installed = await child('/usr/local/bin/node', [`${authority}/verify.mjs`, '--installed'], { LANG: 'C' });
  assert.equal(installed.status, 0, installed.stderr);
  for (const caller of ['broker', 'worker', '--read', '--evidence']) {
    await correctCa();
    await invoke(caller, 'correct CA and hostname', 1);
    await writeFile(RECOMMENDATION_DATABASE_CA, await readFile('/certificates/wrong-ca.pem'));
    await invoke(caller, 'wrong CA', 0);
    await correctCa();
    await invoke(caller, 'wrong hostname', 0, { host: 'wrong-db.test' });
    await rm(RECOMMENDATION_DATABASE_CA);
    await invoke(caller, 'absent CA retains self-signed refusal', 0);
  }
  for (const query of ['sslmode=require', 'sslmode=disable', 'sslmode=verify-ca', '',
    'sslmode=verify-full&sslmode=require', 'sslmode=verify-full&sslrootcert=system']) {
    await correctCa();
    await invoke('worker', `unsafe TLS mode ${query || 'absent'}`, 0, { query });
    assert.equal(outcomes.at(-1).sslRequests, 0);
  }
  for (const [label, modify, restore] of [
    ['writable CA', () => chmod(RECOMMENDATION_DATABASE_CA, 0o664), async () => {}],
    ['non-root CA owner', () => chown(RECOMMENDATION_DATABASE_CA, 1000, 0), async () => {}],
    ['non-root CA group', () => chown(RECOMMENDATION_DATABASE_CA, 0, 1000), async () => {}],
    ['CA symlink', async () => { await rm(RECOMMENDATION_DATABASE_CA); await symlink('/certificates/ca.pem', RECOMMENDATION_DATABASE_CA); }, async () => {}],
    ['writable parent', () => chmod('/etc/openspell', 0o775), () => chmod('/etc/openspell', 0o755)],
    ['non-root parent', () => chown('/etc/openspell', 1000, 0), () => chown('/etc/openspell', 0, 0)],
    ['malformed CA', () => writeFile(RECOMMENDATION_DATABASE_CA, 'malformed'), async () => {}],
    ['empty CA', () => writeFile(RECOMMENDATION_DATABASE_CA, ''), async () => {}],
    ['oversized CA', () => writeFile(RECOMMENDATION_DATABASE_CA, 'x'.repeat(131_073)), async () => {}],
    ['leaf certificate', async () => writeFile(RECOMMENDATION_DATABASE_CA, await readFile('/certificates/server.pem')), async () => {}],
    ['private key appended', async () => writeFile(RECOMMENDATION_DATABASE_CA, pem + await readFile('/certificates/server.key', 'utf8')), async () => {}],
  ]) {
    await correctCa(); await modify();
    await invoke('broker', label, 0);
    assert.equal(outcomes.at(-1).sslRequests, 0);
    await restore();
  }
  await correctCa();
  for (const key of ['NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_USE_SYSTEM_CA', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    await invoke('worker', `ambient ${key}`, 0, { env: { [key]: '' } });
    assert.equal(outcomes.at(-1).sslRequests, 0);
  }
  await writeFile(RECOMMENDATION_DATABASE_CA, await readFile('/certificates/wrong-ca.pem'));
  await invoke('broker', 'launcher clears TLS override', 0, { env: { NODE_TLS_REJECT_UNAUTHORIZED: '0', NODE_EXTRA_CA_CERTS: '/certificates/ca.pem' } });
  assert.equal(checks, 41);
  assert.equal(startups, 4);
  assert.equal(sslRequests, 17);
  await correctCa();
  const featureProbe = `
    import assert from 'node:assert/strict';
    import tls from 'node:tls';
    import { syncBuiltinESMExports } from 'node:module';
    import { initializeRecommendationDatabaseTrust } from '/trust.mjs';
    const before = tls.getCACertificates('default');
    tls.setDefaultCACertificates = undefined;
    syncBuiltinESMExports();
    if (process.argv[1] === 'configured') {
      assert.throws(() => initializeRecommendationDatabaseTrust('postgres://synthetic:synthetic@tls-db.test/disposable?sslmode=verify-full'), /Node 22.19/);
    } else {
      initializeRecommendationDatabaseTrust('postgres://synthetic:synthetic@tls-db.test/disposable');
    }
    assert.deepEqual(tls.getCACertificates('default'), before);
  `;
  assert.equal((await child('/usr/local/bin/node', ['--input-type=module', '-e', featureProbe, 'configured'], {})).status, 0);
  await rm(RECOMMENDATION_DATABASE_CA);
  assert.equal((await child('/usr/local/bin/node', ['--input-type=module', '-e', featureProbe, 'absent'], {})).status, 0);
  // Exercise the actual installer filesystem operations inside this container.
  // Git source selection is a stub here; separate installer tests use real Git.
  await mkdir('/proof/bin', { recursive: true });
  await writeFile('/proof/bin/sudo', '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
  await writeFile('/proof/bin/git', `#!/bin/sh
case "$*" in
  *'rev-parse --show-toplevel') printf '/installation\\n' ;;
  *'rev-parse HEAD'|*'rev-parse refs/remotes/origin/main') printf '${revision}\\n' ;;
  *'status --porcelain --untracked-files=normal') exit 0 ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
  const digest = createHash('sha256').update(pem).digest('hex');
  const install = (hash = digest, file = '/certificates/ca.pem') => child('/bin/bash', [
    '/installation/docs/deploy/install-recommendation-database-ca.sh',
    '--revision', revision, '--certificate', file, '--sha256', hash,
  ], { PATH: '/proof/bin:/usr/local/bin:/usr/bin:/bin' });
  let installerChecks = 0;
  assert.equal((await install()).status, 0); installerChecks += 1;
  assert.equal(await readFile(RECOMMENDATION_DATABASE_CA, 'utf8'), pem);
  assert.equal((await install()).status, 0); installerChecks += 1;
  assert.equal((await install('0'.repeat(64))).status, 1); installerChecks += 1;
  const wrongDigest = createHash('sha256').update(await readFile('/certificates/wrong-ca.pem')).digest('hex');
  assert.equal((await install(wrongDigest, '/certificates/wrong-ca.pem')).status, 1); installerChecks += 1;
  assert.equal(await readFile(RECOMMENDATION_DATABASE_CA, 'utf8'), pem);
  await rm(RECOMMENDATION_DATABASE_CA);
  await symlink('/certificates/ca.pem', RECOMMENDATION_DATABASE_CA);
  assert.equal((await install()).status, 1); installerChecks += 1;
  await rm(RECOMMENDATION_DATABASE_CA);
  await chmod('/etc/openspell', 0o775);
  assert.equal((await install()).status, 1); installerChecks += 1;
  await chmod('/etc/openspell', 0o755);
  assert.equal((await install()).status, 0); installerChecks += 1;
  assert.equal((await readdir('/etc/openspell')).length, 1);
  assert.equal(installerChecks, 7);
  process.stdout.write(JSON.stringify({ checks, verifiedStartups: startups, sslRequests,
    authenticationRequests: 0, installerChecks, featureChecks: 2, workerUid: 1000, externalNetwork: false, outcomes }));
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
}
