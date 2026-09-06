import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, chown, cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import process from 'node:process';

// This is an owned, networkless Docker fixture, never an installation command.
const revision = 'a'.repeat(40);
const root = `/opt/openspell-recommendation-authority/releases/${revision}`;
const launcher = '/usr/local/libexec/openspell-recommendation-authority';
const credential = '/etc/credstore.encrypted/openspell-recommendation-authority-database-url';
const secret = `postgres://${['synthetic', 'operator'].join('_')}:test@127.0.0.1:1/disposable`;
await mkdir(root, { recursive: true, mode: 0o755 });
await cp('/stage', root, { recursive: true });
for (const name of await readdir(root)) { await chown(`${root}/${name}`, 0, 0); await chmod(`${root}/${name}`, 0o644); }
await mkdir('/usr/local/libexec', { recursive: true, mode: 0o755 });
await writeFile(launcher, await readFile(`${root}/LAUNCHER`), { mode: 0o755 });
await mkdir('/etc/credstore.encrypted', { recursive: true, mode: 0o755 });
await writeFile(credential, 'synthetic encrypted input', { mode: 0o600 });
await writeFile('/usr/bin/systemd-creds', `#!/bin/sh\nprintf 'decrypt\\n' >>/proof/decrypt_calls\nprintf '%s' '${secret}'\n`, { mode: 0o755 });
await writeFile('/proof/injection.mjs', "import { writeFileSync } from 'node:fs'; writeFileSync('/proof/injected', 'unexpected');\n");
const injected = { ...process.env, NODE_OPTIONS: '--import /proof/injection.mjs', NODE_PATH: '/proof', DATABASE_URL: secret };
let checks = 0;
function verify(expected) {
  const result = spawnSync('/usr/local/bin/node', [`${root}/verify.mjs`, '--installed'], { encoding: 'utf8', env: { LANG: 'C' } });
  assert.equal(result.status, expected); checks += 1;
}
function refuse(args, environment = injected) {
  const result = spawnSync(launcher, args, { encoding: 'utf8', env: environment, timeout: 10_000 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'OpenSpell recommendation authority operation could not be confirmed\n');
  assert.ok(!JSON.stringify(result).includes(secret)); checks += 1;
}
verify(0);
refuse(['arbitrary-sql', '0', '-', revision]);
await assert.rejects(stat('/proof/decrypt_calls'), { code: 'ENOENT' });
await chmod(credential, 0o644);
refuse(['block', '0', '-', revision]);
await assert.rejects(stat('/proof/decrypt_calls'), { code: 'ENOENT' });
await chmod(credential, 0o600);
// Actual fixed decrypt process runs once; the absent DB connection fails safely.
refuse(['block', '0', '-', revision]);
assert.equal(await readFile('/proof/decrypt_calls', 'utf8'), 'decrypt\n');
await assert.rejects(stat('/proof/injected'), { code: 'ENOENT' }); checks += 1;
await chmod(`${root}/broker.mjs`, 0o664); verify(1);
await chmod(`${root}/broker.mjs`, 0o644);
await chmod('/opt/openspell-recommendation-authority', 0o775); verify(1);
await chmod('/opt/openspell-recommendation-authority', 0o755);
verify(0);
// A launcher that starts an unsafe system interpreter is not a verified install.
await chmod('/usr/bin/env', 0o775); verify(1);
await chmod('/usr/bin/env', 0o755); verify(0);
process.stdout.write(JSON.stringify({ checks, files: (await readdir(root)).length, decryptCalls: 1, injectionExecutions: 0, externalNetwork: false }));
