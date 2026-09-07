import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import { resolve } from 'node:path';
import process from 'node:process';
import { abort, directory, email, root, waitFor, web } from './support.mjs';

// Immutable public Linux images, shared by both suites. The Node image runs
// only gateway.mjs; no application image, private registry or developer cache.
const pinned = (repository, digest) => repository + '@sha256:' + digest;
export const images = {
  db: pinned('docker.io/library/postgres:17', '67f41722b7a8cbdb868a44a4995c846eddfdc2973bccb291ce937dce88ad5675'),
  mail: pinned('public.ecr.aws/supabase/mailpit:v1.30.2', '37a38e48e9338cd7e89dfeb487f37b02ebfcd9cb23111bed2d345e79d37d6dd6'),
  auth: pinned('public.ecr.aws/supabase/gotrue:v2.196.0', 'c0c25187a6b835e65a6f6e6c6b39d090e832d40e6de5186f2c038e0411944232'),
  gateway: pinned('docker.io/library/node:22.22.0-bookworm-slim', '7cc56ef285a8568121537d17b05e72128f01b89c54607b51acf084a50ef483f3'),
};
const label = 'openspell.auth-acceptance';
const { createClient } = web('@supabase/supabase-js');
const { createServerClient } = web('@supabase/ssr');

export function docker(args, input, timeout = 30_000) {
  try {
    return execFileSync('docker', args, { input, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    // execFileSync's message contains argv, which can contain synthetic keys.
    throw new Error(`Docker ${args[0]} failed: ${String(error.stderr ?? error.code ?? error.status).slice(0, 2000)}`, { cause: error });
  }
}

export function prepareImages() {
  assert.equal(process.platform, 'linux', 'Use native Linux Docker, including GitHub-hosted Ubuntu');
  assert.ok(!process.env.DOCKER_HOST || process.env.DOCKER_HOST.startsWith('unix://'), 'Remote Docker is not a disposable test target');
  assert.match(docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']), /^unix:\/\//);
  assert.equal(docker(['info', '--format', '{{.OSType}}']), 'linux');
  for (const [kind, image] of Object.entries(images)) {
    abort.signal.throwIfAborted();
    try { docker(['image', 'inspect', image]); } catch {
      process.stdout.write(`Pulling pinned public ${kind} image\n`);
      docker(['pull', image], undefined, 180_000);
    }
    assert.ok(JSON.parse(docker(['image', 'inspect', image]))[0].Id);
  }
}

export class AuthStack {
  containers = [];
  created = new Set();
  forwarders = [];
  clients = [];
  mailArtifacts = new Map();
  outsideRequests = 0;
  migrations = [];

  constructor(evidence, suite) {
    this.evidence = evidence;
    this.suite = suite;
    this.id = `openspell-auth-${suite}-${Date.now()}-${randomBytes(4).toString('hex')}`;
    this.names = Object.fromEntries(Object.keys(images).map((kind) => [kind, `${this.id}-${kind}`]));
    this.databasePassphrase = evidence.secret(randomBytes(24).toString('hex'));
    this.webPassphrase = evidence.secret(randomBytes(24).toString('hex'));
    this.jwtSecret = evidence.secret(randomBytes(40).toString('hex'));
    this.passphrase = evidence.secret(randomBytes(24).toString('base64url'));
  }

  jwt(role) {
    const now = Math.floor(Date.now() / 1000);
    const body = [{ alg: 'HS256', typ: 'JWT' }, { iss: 'synthetic-auth', role, aud: 'authenticated', iat: now, exp: now + 3600 }]
      .map((value) => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
    return this.evidence.secret(body + '.' + createHmac('sha256', this.jwtSecret).update(body).digest('base64url'));
  }
  run(kind, options = [], command = []) {
    const name = this.names[kind];
    // Register before docker run so cleanup can discover a container even when
    // its create response was lost. Ownership labels are rechecked on deletion.
    this.containers.push(name);
    docker(['run', '--detach', '--name', name, '--label', `${label}=${this.id}`, '--network', this.id, '--network-alias', kind, ...options, images[kind], ...command]);
    this.created.add(name);
  }
  ip(kind) {
    const address = JSON.parse(docker(['inspect', '--format', '{{json .NetworkSettings.Networks}}', this.names[kind]]))[this.id].IPAddress;
    assert.match(address, /^\d+\.\d+\.\d+\.\d+$/);
    return address;
  }
  async forward(kind, port) {
    const host = this.ip(kind);
    const server = http.createServer((request, response) => {
      const upstream = http.request({ host, port, method: request.method, path: request.url, headers: request.headers }, (reply) => {
        response.writeHead(reply.statusCode, reply.headers); reply.pipe(response);
        reply.on('aborted', () => response.destroy());
      });
      upstream.on('error', () => response.destroy()); request.pipe(upstream);
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    this.forwarders.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  }
  async fetch(input, options = {}) {
    const url = new globalThis.URL(typeof input === 'string' || input instanceof globalThis.URL ? input : input.url);
    if (![this.base, this.mailBase].includes(url.origin)) {
      this.outsideRequests++;
      throw new Error('Auth acceptance refused an external fetch');
    }
    return globalThis.fetch(input, { ...options, signal: globalThis.AbortSignal.any([abort.signal, globalThis.AbortSignal.timeout(8000)]) });
  }
  client(key = this.anon) {
    const client = createClient(this.base, key, { global: { fetch: this.fetch.bind(this) }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    this.clients.push(client); return client;
  }
  serverClient(initialCookies = new Map()) {
    const jar = new Map(initialCookies);
    let writes = 0;
    const client = createServerClient(this.base, this.anon, {
      global: { fetch: this.fetch.bind(this) },
      cookies: {
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        setAll: (items) => { writes += items.length; for (const item of items) { if (item.options.maxAge === 0) jar.delete(item.name); else jar.set(item.name, item.value); } },
      },
    });
    this.clients.push(client); return { client, jar, writes: () => writes };
  }
  sql(source) {
    return docker(['exec', '-i', this.names.db, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-tA'], source);
  }
  value(source) { return JSON.parse(this.sql(source)); }
  async start({ appOrigin, expirySeconds }) {
    this.networkRequested = true;
    docker(['network', 'create', '--internal', '--label', `${label}=${this.id}`, this.id]);
    assert.equal(docker(['network', 'inspect', '--format', '{{.Internal}}', this.id]), 'true');
    this.run('db', ['--env', 'POSTGRES_DB=postgres', '--env', 'POSTGRES_USER=postgres', '--env', `POSTGRES_PASSWORD=${this.databasePassphrase}`, '--tmpfs', '/var/lib/postgresql/data']);
    this.run('mail');
    this.run('gateway', [
      '--mount', `type=bind,src=${resolve(directory, 'gateway.mjs')},dst=/fixture/gateway.mjs,readonly`,
      '--mount', `type=bind,src=${resolve(root, 'supabase/templates/invite.html')},dst=/fixture/invite.html,readonly`,
    ], ['node', '/fixture/gateway.mjs']);
    this.base = await this.forward('gateway', 8080);
    this.mailBase = await this.forward('mail', 8025);
    this.appOrigin = appOrigin ?? this.base;
    await waitFor('PostgreSQL', async () => {
      // The image's temporary initialization server accepts Unix sockets and
      // then stops. Only the final server listens on TCP; probing it avoids
      // racing that shutdown before the first schema statement.
      try { return docker(['exec', this.names.db, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']).includes('accepting connections'); } catch { return false; }
    });
    const shim = readFileSync(resolve(root, 'supabase/tests/supabase-platform-shim.sql'), 'utf8');
    const boundary = shim.indexOf('-- ---------------------------------------------------------------------------\n-- auth\n');
    assert.ok(boundary > 0, 'Platform fixture boundary must exist');
    this.sql(shim.slice(0, boundary));
    this.sql('create schema auth;');
    const config = {
      GOTRUE_API_HOST: '0.0.0.0', GOTRUE_API_PORT: '9999', PORT: '9999', API_EXTERNAL_URL: this.base + '/auth/v1',
      GOTRUE_DB_DRIVER: 'postgres', GOTRUE_DB_DATABASE_URL: `postgres://postgres:${this.databasePassphrase}@db:5432/postgres?search_path=auth`,
      GOTRUE_SITE_URL: this.appOrigin, GOTRUE_URI_ALLOW_LIST: this.appOrigin + '/agency-invite/**', GOTRUE_DISABLE_SIGNUP: 'true',
      GOTRUE_JWT_SECRET: this.jwtSecret, GOTRUE_JWT_AUD: 'authenticated', GOTRUE_JWT_DEFAULT_GROUP_NAME: 'authenticated', GOTRUE_JWT_ADMIN_ROLES: 'service_role', GOTRUE_JWT_EXP: '3600',
      GOTRUE_EXTERNAL_EMAIL_ENABLED: 'true', GOTRUE_MAILER_AUTOCONFIRM: 'false', GOTRUE_MAILER_OTP_EXP: String(expirySeconds),
      GOTRUE_SMTP_HOST: 'mail', GOTRUE_SMTP_PORT: '1025', GOTRUE_SMTP_ADMIN_EMAIL: email('sender'), GOTRUE_SMTP_SENDER_NAME: 'Synthetic Auth Acceptance', GOTRUE_SMTP_MAX_FREQUENCY: '1s',
      GOTRUE_MAILER_TEMPLATES_INVITE: 'http://gateway:8080/template', GOTRUE_PASSWORD_MIN_LENGTH: '10', GOTRUE_LOG_LEVEL: 'error',
      GOTRUE_RATE_LIMIT_EMAIL_SENT: '1000', GOTRUE_RATE_LIMIT_VERIFY: '1000', GOTRUE_RATE_LIMIT_TOKEN_REFRESH: '1000', GOTRUE_RATE_LIMIT_OTP: '1000',
    };
    this.run('auth', Object.entries(config).flatMap(([key, value]) => ['--env', `${key}=${value}`]));
    await waitFor('Auth and Mailpit', async () => {
      try { return (await this.fetch(this.base + '/auth/v1/health')).status === 200 && (await this.fetch(this.mailBase + '/api/v1/messages')).status === 200; } catch { return false; }
    });
    this.anon = this.jwt('anon'); this.admin = this.client(this.jwt('service_role'));
  }
  migrate() {
    this.sql(readFileSync(resolve(root, 'supabase/tests/supabase-platform-shim.sql'), 'utf8'));
    const files = readdirSync(resolve(root, 'supabase/migrations')).filter((name) => name.endsWith('.sql')).sort();
    assert.ok(files.includes('20260907050000_agency_bootstrap_invitations.sql'));
    assert.ok(files.includes('20260907060000_verified_team_invitation_acceptance.sql'));
    for (const name of files) {
      const source = readFileSync(resolve(root, 'supabase/migrations', name), 'utf8');
      this.sql('begin;\n' + source + '\ncommit;');
      this.migrations.push({ name, sha256: createHash('sha256').update(source).digest('hex') });
    }
    assert.equal(this.migrations.length, files.length);
    this.sql(`alter role service_role login password '${this.webPassphrase}'; grant anon, authenticated to service_role with inherit false, set true;`);
    this.databaseUrl = `postgres://service_role:${this.webPassphrase}@${this.ip('db')}:5432/postgres`;
  }
  async messages() {
    const response = await this.fetch(this.mailBase + '/api/v1/messages?limit=100');
    assert.equal(response.status, 200);
    const body = await response.json(); assert.ok(Array.isArray(body.messages)); return body.messages;
  }
  async mailFor(address, count = 1) {
    let messages;
    await waitFor('captured email', async () => {
      messages = (await this.messages()).filter((item) => item.To?.some((to) => to.Address === address));
      return messages.length >= count;
    });
    assert.equal(messages.length, count);
    return Promise.all(messages.map(async (item) => {
      const message = await (await this.fetch(this.mailBase + '/api/v1/message/' + item.ID)).json();
      const link = message.HTML.match(/href="([^"]+)"/)?.[1]; assert.ok(link);
      const url = new globalThis.URL(link.replaceAll('&amp;', '&'));
      const hash = this.evidence.secret(url.searchParams.get('token_hash')); assert.ok(hash);
      this.mailArtifacts.set(item.ID, { recipient: address, subject: message.Subject, html: this.evidence.sanitize(message.HTML) });
      return { id: item.ID, url, hash };
    }));
  }
  async user(id) { const result = await this.admin.auth.admin.getUserById(id); assert.equal(result.error, null); return result.data.user; }
  async users() { const result = await this.admin.auth.admin.listUsers({ page: 1, perPage: 100 }); assert.equal(result.error, null); return result.data.users; }
  async events() { return (await this.fetch(this.base + '/events')).json(); }
  async fault(method, path) {
    assert.equal((await this.fetch(this.base + '/fault', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, path }) })).status, 200);
  }
  close() { return this.closing ??= this.cleanup(); }
  async cleanup() {
    const errors = []; const removed = [];
    for (const client of this.clients) {
      try { await client.auth.stopAutoRefresh(); } catch (error) { errors.push(this.evidence.problem(error)); }
    }
    try { if (this.base) this.evidence.json(`${this.suite}-auth.json`, { events: await this.events(), mail: [...this.mailArtifacts.values()] }); } catch { /* Interrupted fetches do not delay resource removal. */ }
    for (const server of this.forwarders) { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
    for (const name of [...this.containers].reverse()) {
      try {
        if (!docker(['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'])) continue;
        assert.equal(docker(['inspect', '--format', `{{index .Config.Labels "${label}"}}`, name]), this.id);
        this.created.add(name); docker(['rm', '--force', name]); removed.push(name);
      } catch (error) { errors.push(this.evidence.problem(error)); }
    }
    if (this.networkRequested) {
      try {
        const present = docker(['network', 'ls', '--filter', `name=^${this.id}$`, '--format', '{{.Name}}']).split('\n');
        if (present.includes(this.id)) {
          assert.equal(docker(['network', 'inspect', '--format', `{{index .Labels "${label}"}}`, this.id]), this.id);
          docker(['network', 'rm', this.id]); this.networkRemoved = true;
        }
      } catch (error) { errors.push(this.evidence.problem(error)); }
    }
    this.cleanupResult = { created: this.created.size, removed: removed.length, networkRemoved: this.networkRemoved ?? false, errors };
    assert.equal(removed.length, this.created.size, 'Every owned container must be removed');
    assert.equal(errors.length, 0, 'Disposable cleanup must complete');
  }
}
