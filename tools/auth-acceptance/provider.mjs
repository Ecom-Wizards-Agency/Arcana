import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { email, sleep } from './support.mjs';

export const providerChecks = 14;

/** Actual SDK -> HTTP proxy -> GoTrue -> PostgreSQL/SMTP. No Auth doubles. */
export async function providerSuite(stack, evidence) {
  const check = (name, run) => evidence.check('provider', name, run);
  const passphrase = stack.passphrase;
  const redirect = () => stack.appOrigin + '/agency-invite/' + evidence.secret(randomBytes(32).toString('base64url'));
  async function invite(label, redirectTo = redirect()) {
    const address = email(label);
    const result = await stack.admin.auth.admin.inviteUserByEmail(address, { redirectTo });
    assert.equal(result.error, null); assert.ok(result.data.user);
    const mail = (await stack.mailFor(address))[0];
    return { address, user: result.data.user, mail, redirectTo };
  }
  async function verify(invitation, client = stack.client()) {
    assert.equal((await client.auth.initialize()).error, null);
    const result = await client.auth.verifyOtp({ type: 'invite', token_hash: invitation.mail.hash });
    assert.equal(result.error, null); assert.ok(result.data.session);
    assert.equal(result.data.user.email, invitation.address); assert.ok(result.data.user.email_confirmed_at);
    return client;
  }
  async function login(address, passphrase = stack.passphrase) {
    return stack.client().auth.signInWithPassword({ email: address, password: passphrase });
  }

  await check('signup is disabled', async () => {
    const result = await stack.client().auth.signUp({ email: email('not-invited'), password: passphrase });
    assert.equal(result.error?.code, 'signup_disabled'); assert.equal(result.data.user, null);
    assert.equal((await stack.users()).length, 0); assert.equal((await stack.messages()).length, 0);
    return { users: 0, emails: 0 };
  });
  let missing; let session;
  await check('missing account receives maintained template, verifies and sets a password', async () => {
    missing = await invite('missing'); assert.ok(!missing.user.email_confirmed_at);
    assert.equal(missing.mail.url.origin, stack.appOrigin);
    assert.equal(missing.mail.url.pathname, new globalThis.URL(missing.redirectTo).pathname);
    assert.equal(missing.mail.url.hash, ''); assert.equal(missing.mail.url.searchParams.has('code'), false);
    session = stack.serverClient(); await verify(missing, session.client); assert.ok(session.writes() > 0);
    const before = (await stack.events()).length;
    assert.equal((await session.client.auth.updateUser({ password: passphrase })).error, null);
    assert.equal((await login(missing.address)).data.user.id, missing.user.id);
    assert.equal((await login(missing.address, randomBytes(24).toString('hex'))).error?.code, 'invalid_credentials');
    assert.ok(!(await stack.events()).slice(before).some((row) => row.path.startsWith('/admin/')));
    return { emails: 1, verifiedEmail: true, sessionCookieWrites: session.writes(), ordinaryPasswordLogin: true };
  });
  await check('consumed Auth token cannot be replayed', async () => {
    const result = await stack.client().auth.verifyOtp({ type: 'invite', token_hash: missing.mail.hash });
    assert.equal(result.error?.code, 'otp_expired'); assert.equal(result.data.session, null);
    return { replaySessions: 0 };
  });
  await check('existing unconfirmed account is reused and retains its password', async () => {
    const made = await stack.admin.auth.admin.createUser({ email: email('unconfirmed'), password: passphrase, email_confirm: false });
    assert.equal(made.error, null);
    const item = await invite('unconfirmed'); assert.equal(item.user.id, made.data.user.id);
    await verify(item); assert.equal((await login(item.address)).error, null);
    return { sameUser: true, passwordPreserved: true, emails: 1 };
  });
  let confirmed;
  await check('existing confirmed account returns email_exists without sending mail', async () => {
    confirmed = await stack.admin.auth.admin.createUser({ email: email('confirmed'), password: passphrase, email_confirm: true });
    assert.equal(confirmed.error, null);
    const before = (await stack.messages()).length;
    const result = await stack.admin.auth.admin.inviteUserByEmail(email('confirmed'), { redirectTo: redirect() });
    assert.equal(result.error?.code, 'email_exists'); assert.equal((await stack.messages()).length, before);
    assert.equal((await login(email('confirmed'))).error, null);
    return { additionalEmails: 0, passwordPreserved: true };
  });
  await check('explicit resend rotates the token without creating another account', async () => {
    const first = await invite('resend'); await sleep(1150);
    const result = await stack.admin.auth.admin.inviteUserByEmail(first.address, { redirectTo: first.redirectTo });
    assert.equal(result.error, null); assert.equal(result.data.user.id, first.user.id);
    const mails = await stack.mailFor(first.address, 2);
    const latest = mails.find((mail) => mail.id !== first.mail.id); assert.ok(latest);
    assert.notEqual(latest.hash, first.mail.hash);
    assert.equal((await stack.client().auth.verifyOtp({ type: 'invite', token_hash: first.mail.hash })).error?.code, 'otp_expired');
    await verify({ ...first, mail: latest });
    return { emails: 2, sameUser: true, oldTokenRefused: true };
  });
  await check('Auth enforces real wall-clock token expiry', async () => {
    const item = await invite('expired'); await sleep(6500);
    assert.equal((await stack.client().auth.verifyOtp({ type: 'invite', token_hash: item.mail.hash })).error?.code, 'otp_expired');
    assert.ok(!(await stack.user(item.user.id)).email_confirmed_at);
    return { expirySeconds: 5, waitedMilliseconds: 6500, unconfirmed: true };
  });
  await check('provider verification can replace an existing session', async () => {
    const item = await invite('wrong-account'); const client = stack.client();
    assert.equal((await client.auth.signInWithPassword({ email: email('confirmed'), password: passphrase })).error, null);
    assert.equal((await client.auth.getUser()).data.user.id, confirmed.data.user.id);
    await verify(item, client); assert.equal((await client.auth.getUser()).data.user.id, item.user.id);
    return { applicationWrongAccountGuardRequired: true };
  });
  await check('unallowlisted callback falls back to SiteURL', async () => {
    const item = await invite('invalid-redirect', 'https://outside.invalid/invitation');
    assert.equal(item.mail.url.origin, stack.appOrigin); assert.equal(item.mail.url.pathname, '/');
    return { externalRedirectRefused: true };
  });
  await check('lost invite response can still create an account and send mail', async () => {
    const address = email('lost-invite');
    const before = (await stack.events()).filter((row) => row.path === '/invite').length;
    await stack.fault('POST', '/invite');
    const result = await stack.admin.auth.admin.inviteUserByEmail(address, { redirectTo: redirect() });
    assert.equal(result.error?.name, 'AuthRetryableFetchError'); assert.equal(result.data.user, null);
    await stack.mailFor(address); assert.equal((await stack.users()).filter((user) => user.email === address).length, 1);
    assert.equal((await stack.events()).filter((row) => row.path === '/invite').length - before, 1);
    return { users: 1, emails: 1, inviteAttempts: 1 };
  });
  await check('lost verification consumes the token without saving SSR cookies', async () => {
    const item = await invite('lost-verify'); const receiving = stack.serverClient();
    await receiving.client.auth.initialize(); await stack.fault('POST', '/verify');
    const result = await receiving.client.auth.verifyOtp({ type: 'invite', token_hash: item.mail.hash });
    assert.equal(result.error?.name, 'AuthRetryableFetchError'); assert.equal(receiving.writes(), 0);
    assert.ok((await stack.user(item.user.id)).email_confirmed_at);
    assert.equal((await stack.client().auth.verifyOtp({ type: 'invite', token_hash: item.mail.hash })).error?.code, 'otp_expired');
    return { confirmedEmail: true, cookieWrites: 0, replayRefused: true };
  });
  await check('lost password response reconciles through ordinary login', async () => {
    const item = await invite('lost-password'); const client = await verify(item);
    await stack.fault('PUT', '/user');
    assert.equal((await client.auth.updateUser({ password: passphrase })).error?.name, 'AuthRetryableFetchError');
    assert.equal((await login(item.address)).data.user.id, item.user.id);
    return { passwordCommitted: true, ordinaryLoginReconciles: true };
  });
  await check('a fresh SSR request validates the real session cookies', async () => {
    const receiving = stack.serverClient(session.jar);
    const result = await receiving.client.auth.getUser(); assert.equal(result.error, null);
    assert.equal(result.data.user.id, missing.user.id); assert.ok(result.data.user.email_confirmed_at);
    return { sameVerifiedUser: true };
  });
  await check('provider counts reconcile', async () => {
    const users = (await stack.users()).length; const emails = (await stack.messages()).length;
    const faults = (await stack.events()).filter((row) => row.responseDropped);
    assert.equal(users, 10); assert.equal(emails, 10); assert.equal(stack.mailArtifacts.size, 10);
    assert.equal(faults.length, 3); assert.ok(faults.every((row) => row.status === 200));
    assert.equal(stack.outsideRequests, 0);
    return { users, emails, committedResponseFaults: faults.length, externalRequests: 0 };
  });
  evidence.count('provider', providerChecks);
}
