import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import net from 'node:net';
import { resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { abort, childEnvironment, directory, email, root, waitFor, web } from './support.mjs';

export async function applicationOrigin() {
  const server = net.createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return `http://127.0.0.1:${port}`;
}

async function stopProcess(child) {
  if (!child?.pid) return;
  const exited = new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null) done(); else child.once('exit', done);
  });
  try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  await Promise.race([exited, delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await Promise.race([exited, delay(3000)]);
  }
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'Owned child process must stop');
}

export class Application {
  requests = [];
  responses = [];
  browserErrors = [];
  externalRequests = 0;
  children = [];
  logs = '';

  constructor(stack, evidence) {
    this.stack = stack; this.evidence = evidence; this.origin = stack.appOrigin;
    this.network = {
      NODE_OPTIONS: `--import=${pathToFileURL(resolve(directory, 'network-guard.mjs')).href}`,
      OPENSPELL_TEST_HTTP_ORIGINS: JSON.stringify([stack.base, stack.mailBase, this.origin]),
    };
  }

  async start() {
    for (const path of [root, resolve(root, 'apps/web')]) {
      assert.equal(readdirSync(path).filter((name) => /^\.env(?:\.|$)/.test(name)).length, 0, 'Remove application .env files before running disposable acceptance');
    }
    const env = childEnvironment({
      ...this.network, NODE_OPTIONS: this.network.NODE_OPTIONS + ' --max-old-space-size=4096',
      NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1',
      NEXT_FONT_GOOGLE_MOCKED_RESPONSES: resolve(directory, 'next-font.cjs'),
      DATABASE_URL: this.stack.databaseUrl,
      NEXT_PUBLIC_SUPABASE_URL: this.stack.base, NEXT_PUBLIC_SUPABASE_ANON_KEY: this.stack.anon,
      WIZARD_ADS_APP_URL: this.origin, WIZARD_ADS_E2E_AUTH: '0', WIZARD_ADS_E2E_AUTH_BRIDGE: '0',
      WIZARD_ADS_PASSWORD_LOGIN: '1', WIZARD_ADS_PASSWORD_RECOVERY: '1', WIZARD_ADS_TOTP_POLICY: 'off', WIZARD_ADS_PASSKEYS: 'off',
    });
    assert.ok(!env.SUPABASE_SERVICE_ROLE_KEY);
    this.next = spawn(process.execPath, [web.resolve('next/dist/bin/next'), 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', new globalThis.URL(this.origin).port], {
      cwd: resolve(root, 'apps/web'), env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.children.push(this.next);
    const log = (chunk) => { this.logs = (this.logs + String(chunk)).slice(-4 * 1024 * 1024); };
    this.next.stdout.on('data', log); this.next.stderr.on('data', log);
    this.next.on('error', (error) => { this.startError = error; });
    await waitFor('Next login page', async () => {
      if (this.startError) throw this.startError;
      assert.equal(this.next.exitCode, null, 'Next must stay running');
      try { return (await globalThis.fetch(this.origin + '/login', { signal: globalThis.AbortSignal.any([abort.signal, globalThis.AbortSignal.timeout(15_000)]) })).status === 200; } catch { return false; }
    }, 120_000);
    this.browser = await web('@playwright/test').chromium.launch({ headless: true });
  }

  async provision(name) {
    const args = ['--import', web.resolve('tsx'), resolve(root, 'tools/agency-operator/src/cli.ts'),
      'provision', '--request-id', randomUUID(), '--name', 'Synthetic agency ' + name,
      '--slug', 'synthetic-agency-' + name, '--owner-email', email(name), '--send-email'];
    const env = childEnvironment({ ...this.network,
      OPENSPELL_OPERATOR_DATABASE_URL: this.stack.databaseUrl, WIZARD_ADS_APP_URL: this.origin,
      OPENSPELL_OPERATOR_AUTH_URL: this.stack.base, OPENSPELL_OPERATOR_AUTH_KEY: this.stack.jwt('service_role'),
    });
    const output = await new Promise((done, reject) => {
      const child = spawn(process.execPath, args, { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'], signal: abort.signal, timeout: 60_000 });
      this.children.push(child);
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) done(stdout);
        else { this.evidence.text('operator-error.log', stderr); reject(new Error(`Agency operator exited ${code}`)); }
      });
    });
    const result = JSON.parse(output);
    this.evidence.secret(result.invitationUrl?.split('/').at(-1));
    assert.equal(result.delivery, 'accepted_by_provider'); assert.ok(result.invitationUrl);
    const mail = (await this.stack.mailFor(email(name)))[0];
    assert.equal(mail.url.origin, this.origin); assert.equal(mail.url.pathname, new globalThis.URL(result.invitationUrl).pathname);
    const user = (await this.stack.users()).find((item) => item.email === email(name)); assert.ok(user);
    return { result, mail, user, address: email(name) };
  }

  async context(options = {}) {
    const context = await this.browser.newContext(options);
    await context.route('**/*', async (route) => {
      const url = new globalThis.URL(route.request().url());
      if (![this.origin, this.stack.base].includes(url.origin)) { this.externalRequests++; return route.abort('blockedbyclient'); }
      return route.continue();
    });
    context.on('page', (page) => page.on('pageerror', (error) => this.browserErrors.push(this.evidence.problem(error))));
    context.on('request', (request) => {
      const url = new globalThis.URL(request.url());
      this.requests.push({ method: request.method(), path: this.evidence.sanitize(url.pathname), origin: request.headers().origin ?? null });
    });
    context.on('response', async (response) => {
      const headers = response.headers();
      this.responses.push({ method: response.request().method(), path: this.evidence.sanitize(new globalThis.URL(response.url()).pathname),
        status: response.status(), location: this.evidence.sanitize(headers.location ?? ''), actionRedirect: this.evidence.sanitize(headers['x-action-redirect'] ?? ''), contentType: headers['content-type'] ?? '' });
    });
    return context;
  }

  close() { return this.closing ??= this.cleanup(); }
  async cleanup() {
    const errors = [];
    if (this.page && !abort.signal.aborted) {
      try {
        this.evidence.json('browser-state.json', { url: this.evidence.sanitize(this.page.url()), text: await this.page.locator('body').innerText({ timeout: 3000 }) });
      } catch { /* A closed browser may have no final document. */ }
    }
    if (this.browser) { try { await this.browser.close(); } catch (error) { errors.push(this.evidence.problem(error)); } }
    for (const child of [...this.children].reverse()) {
      try { await stopProcess(child); } catch (error) { errors.push(this.evidence.problem(error)); }
    }
    this.evidence.text('next.log', this.logs);
    this.evidence.json('browser-http.json', { requests: this.requests, responses: this.responses, errors: this.browserErrors });
    this.cleanupResult = { nextStopped: !this.next || this.next.exitCode !== null || this.next.signalCode !== null, errors };
    assert.equal(errors.length, 0, 'Every owned application process must stop');
  }
}
