import assert from 'node:assert/strict';
import { web } from './support.mjs';

export const browserChecks = 12;
const expect = web('@playwright/test').expect.configure({ timeout: 45_000 });
const memberCount = (stack) => stack.value('select count(*) from public.org_members');
const auditCount = (stack) => stack.value("select count(*) from public.audit_log where action = 'agency.owner_accepted'");
const linkAuditCount = (stack) => stack.value("select count(*) from public.audit_log where action = 'agency.invitation_link_issued'");
const verifications = async (stack) => (await stack.events()).filter((row) => row.path === '/verify').length;

export async function browserSuite(stack, application, evidence) {
  const check = (name, run) => evidence.check('browser', name, run);
  await check('every application migration applies beside the real Auth schema', async () => {
    stack.migrate();
    assert.equal((await stack.users()).length, 0); assert.equal(memberCount(stack), 0);
    return { migrations: stack.migrations.length, initialUsers: 0, initialMemberships: 0 };
  });
  await application.start();
  const first = await application.provision('first');
  const second = await application.provision('second');
  await check('operator provisions two agencies and delivers two emails without joining either', async () => {
    assert.equal(stack.value('select count(*) from public.orgs'), 2);
    assert.equal((await stack.users()).length, 2); assert.equal((await stack.messages()).length, 2);
    assert.equal(memberCount(stack), 0);
    return { agencies: 2, users: 2, emails: 2, memberships: 0 };
  });

  // Native forms are required before hydration. A hydrated-only test can hide
  // an Origin:null rejection caused by an incompatible referrer policy.
  const owner = await application.context({ javaScriptEnabled: false });
  owner.setDefaultTimeout(45_000); owner.setDefaultNavigationTimeout(90_000);
  const page = await owner.newPage(); application.page = page;
  await check('landing GET and reload consume no Auth or membership authority', async () => {
    const before = (await stack.events()).filter((row) => row.path === '/verify').length;
    await page.goto(first.mail.url.toString());
    await expect(page.getByRole('button', { name: 'Continue with email invitation' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Continue with email invitation' })).toBeVisible();
    assert.equal((await stack.events()).filter((row) => row.path === '/verify').length, before);
    assert.ok(!(await stack.user(first.user.id)).email_confirmed_at); assert.equal(memberCount(stack), 0);
    assert.equal(await page.locator('meta[name=referrer]').getAttribute('content'), 'same-origin');
    return { landingGets: 2, verificationCalls: 0, memberships: 0 };
  });
  await check('explicit native verification opens password setup with real SSR cookies', async () => {
    const before = (await stack.events()).filter((row) => row.path === '/verify').length;
    await page.getByRole('button', { name: 'Continue with email invitation' }).click();
    await expect(page).toHaveURL(/\/recover-password\?.*setup=1/);
    await expect(page.getByRole('heading', { name: 'Set password' })).toBeVisible();
    assert.ok((await stack.user(first.user.id)).email_confirmed_at);
    assert.equal((await stack.events()).filter((row) => row.path === '/verify').length - before, 1);
    const cookies = await owner.cookies();
    assert.ok(cookies.some((cookie) => cookie.name.startsWith('sb-') && cookie.name.includes('auth-token')));
    assert.ok(!cookies.some((cookie) => cookie.name.startsWith('wizard_ads_e2e')));
    assert.equal(memberCount(stack), 0);
    return { verificationPosts: 1, realSession: true, e2eIdentityCookies: 0, memberships: 0 };
  });
  await check('ordinary password setup preserves the application invitation', async () => {
    const before = (await stack.events()).length;
    await page.getByLabel('New password', { exact: true }).fill(stack.passphrase);
    await page.getByLabel('Confirm password', { exact: true }).fill(stack.passphrase);
    await page.getByRole('button', { name: 'Set password', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Password saved.' })).toBeVisible();
    await page.getByRole('link', { name: 'Continue', exact: true }).click();
    await expect(page).toHaveURL(first.result.invitationUrl);
    await expect(page.getByRole('button', { name: 'Accept invitation', exact: true })).toBeVisible();
    const calls = (await stack.events()).slice(before);
    assert.ok(calls.some((row) => row.method === 'PUT' && row.path === '/user'));
    assert.ok(!calls.some((row) => row.path.startsWith('/admin/'))); assert.equal(memberCount(stack), 0);
    return { ordinaryPasswordUpdate: true, adminCalls: 0, memberships: 0 };
  });
  await check('native acceptance creates exactly the intended owner membership and audit', async () => {
    await page.getByRole('button', { name: 'Accept invitation', exact: true }).click();
    await expect(page).toHaveURL(application.origin + '/');
    // Next's streamed Home page needs JavaScript for visibility. Its visible
    // state is checked below in a fresh ordinary password-login browser.
    await expect(page.getByText('No profiles yet', { exact: true })).toBeAttached();
    const members = stack.value("select coalesce(json_agg(row_to_json(m)), '[]'::json) from (select org_id, user_id, role from public.org_members) m");
    assert.deepEqual(members, [{ org_id: first.result.receipt.orgId, user_id: first.user.id, role: 'owner' }]);
    assert.equal((await owner.cookies()).find((cookie) => cookie.name === 'wizard_ads_org')?.value, first.result.receipt.orgId);
    assert.equal(auditCount(stack), 1);
    return { memberships: 1, acceptanceAudits: 1, exactAgencyCookie: true, otherAgencyMemberships: 0 };
  });
  await check('accepted invitation replay adds no membership or audit', async () => {
    await page.goto(first.result.invitationUrl);
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    await expect(page).toHaveURL(application.origin + '/');
    assert.equal(memberCount(stack), 1); assert.equal(auditCount(stack), 1);
    const nativePosts = application.requests.filter((request) => request.method === 'POST' && request.path.startsWith('/agency-invite/'));
    assert.equal(nativePosts.length, 3); assert.ok(nativePosts.every((request) => request.origin === application.origin));
    return { memberships: 1, acceptanceAudits: 1, nativePostsWithCorrectOrigin: 3 };
  });
  await check('wrong account is refused by both landing and actual verification action', async () => {
    const anonymous = await application.context({ javaScriptEnabled: false });
    const anonymousPage = await anonymous.newPage(); await anonymousPage.goto(second.mail.url.toString());
    const fields = await anonymousPage.getByRole('button', { name: 'Continue with email invitation' }).locator('..').locator('input')
      .evaluateAll((inputs) => Object.fromEntries(inputs.map((input) => [input.name, input.value])));
    assert.ok(fields.auth_token_hash); assert.ok(Object.keys(fields).some((key) => key.startsWith('$ACTION_')));
    const before = (await stack.events()).filter((row) => row.path === '/verify').length;
    await page.goto(second.mail.url.toString());
    await expect(page.getByText('This invitation was issued to a different address.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue with email invitation' })).toHaveCount(0);
    // Genuine existing session and actual bound form fields, with a valid
    // Origin, reach the account guard rather than failing a CSRF check first.
    const response = await owner.request.post(second.result.invitationUrl, { multipart: fields, headers: { Origin: application.origin }, maxRedirects: 0 });
    assert.equal(response.status(), 303); assert.ok(response.headers().location.endsWith('?error=account'));
    assert.equal((await stack.events()).filter((row) => row.path === '/verify').length, before);
    assert.ok(!(await stack.user(second.user.id)).email_confirmed_at); assert.equal(memberCount(stack), 1);
    await anonymous.close();
    return { verificationCalls: 0, wrongAccountActionRefused: true, memberships: 1 };
  });
  await check('fresh hydrated password login reaches the Home URL and visible agency', async () => {
    const fresh = await application.context(); const signedInPage = await fresh.newPage(); application.page = signedInPage;
    await signedInPage.goto(application.origin + '/login');
    await signedInPage.getByLabel('Email', { exact: true }).fill(first.address);
    await signedInPage.getByLabel('Password', { exact: true }).fill(stack.passphrase);
    await signedInPage.getByRole('button', { name: 'Sign in', exact: true }).click();
    // Checking content alone misses an App Router action that streams the
    // Home while leaving the address at its /auth/continue checkpoint.
    await expect(signedInPage).toHaveURL(application.origin + '/');
    await expect(signedInPage.getByText('No profiles yet', { exact: true })).toBeVisible();
    await signedInPage.goto(first.result.invitationUrl);
    await expect(signedInPage.getByRole('button', { name: 'Open workspace', exact: true })).toBeVisible();
    assert.equal(memberCount(stack), 1);
    return { freshPasswordLogin: true, correctHomeUrl: true, visibleOwnedAgency: true };
  });
  let third;
  await check('operator link delivery activates a new owner with no email', async () => {
    third = await application.provision('third', { link: true });
    assert.equal((await stack.messages()).length, 2); assert.equal(linkAuditCount(stack), 1);
    const linkContext = await application.context({ javaScriptEnabled: false });
    linkContext.setDefaultTimeout(45_000); linkContext.setDefaultNavigationTimeout(90_000);
    const linkPage = await linkContext.newPage(); application.page = linkPage;
    const before = await verifications(stack);
    await linkPage.goto(third.result.invitationUrl);
    await expect(linkPage.getByRole('button', { name: 'Continue with email invitation' })).toBeVisible();
    assert.equal(await verifications(stack), before);
    await linkPage.getByRole('button', { name: 'Continue with email invitation' }).click();
    await expect(linkPage).toHaveURL(/\/recover-password\?.*setup=1/);
    assert.equal(await verifications(stack) - before, 1); assert.ok((await stack.user(third.user.id)).email_confirmed_at);
    await linkPage.getByLabel('New password', { exact: true }).fill(stack.passphrase);
    await linkPage.getByLabel('Confirm password', { exact: true }).fill(stack.passphrase);
    await linkPage.getByRole('button', { name: 'Set password', exact: true }).click();
    await expect(linkPage.getByRole('status').filter({ hasText: 'Password saved.' })).toBeVisible();
    await linkPage.getByRole('link', { name: 'Continue', exact: true }).click();
    const plain = new globalThis.URL(third.result.invitationUrl); plain.search = '';
    await expect(linkPage).toHaveURL(plain.toString());
    await linkPage.getByRole('button', { name: 'Accept invitation', exact: true }).click();
    await expect(linkPage).toHaveURL(application.origin + '/');
    const owners = stack.value(`select count(*) from public.org_members where org_id = '${third.result.receipt.orgId}' and user_id = '${third.user.id}' and role = 'owner'`);
    assert.equal(owners, 1); assert.equal(memberCount(stack), 2); assert.equal(auditCount(stack), 2);
    await linkContext.close();
    return { emails: 0, linkAudits: 1, verificationPosts: 1, memberships: 2, acceptanceAudits: 2 };
  });
  await check('owner-issued reset link replaces a password only after an explicit POST', async () => {
    const generated = await stack.admin.auth.admin.generateLink({ type: 'recovery', email: first.address, options: { redirectTo: application.origin + '/auth/recovery/callback?next=%2Fdashboard' } });
    assert.equal(generated.error, null);
    for (const value of [generated.data.properties.hashed_token, generated.data.properties.email_otp, generated.data.properties.action_link]) evidence.secret(value);
    // The same URL the Members screen shows once.
    const link = new globalThis.URL('/auth/recovery/callback', application.origin);
    link.searchParams.set('next', '/dashboard'); link.searchParams.set('token_hash', generated.data.properties.hashed_token);
    const resetContext = await application.context({ javaScriptEnabled: false });
    resetContext.setDefaultTimeout(45_000); resetContext.setDefaultNavigationTimeout(90_000);
    const resetPage = await resetContext.newPage(); application.page = resetPage;
    const before = await verifications(stack);
    await resetPage.goto(link.toString());
    await expect(resetPage.getByRole('button', { name: 'Continue to set a new password' })).toBeVisible();
    await resetPage.reload();
    assert.equal(await verifications(stack), before);
    await resetPage.getByRole('button', { name: 'Continue to set a new password' }).click();
    await expect(resetPage).toHaveURL(application.origin + '/recover-password?next=%2Fdashboard');
    assert.equal(await verifications(stack) - before, 1);
    const replacement = evidence.secret(stack.passphrase + '-reset');
    await resetPage.getByLabel('New password', { exact: true }).fill(replacement);
    await resetPage.getByLabel('Confirm password', { exact: true }).fill(replacement);
    await resetPage.getByRole('button', { name: 'Replace password', exact: true }).click();
    await expect(resetPage.getByRole('status').filter({ hasText: 'Password saved.' })).toBeVisible();
    const signIn = (candidate) => stack.client().auth.signInWithPassword({ email: first.address, password: candidate });
    assert.equal((await signIn(replacement)).error, null);
    assert.equal((await signIn(stack.passphrase)).error?.code, 'invalid_credentials');
    const replay = await resetContext.request.post(application.origin + '/auth/recovery/callback', {
      form: { token_hash: generated.data.properties.hashed_token, next: '/dashboard' }, headers: { Origin: application.origin }, maxRedirects: 0,
    });
    assert.equal(replay.status(), 303); assert.equal(new globalThis.URL(replay.headers().location).pathname, '/forgot-password');
    assert.equal((await stack.messages()).length, 2); assert.equal(memberCount(stack), 2);
    await resetContext.close();
    return { landingGets: 2, verificationPosts: 1, passwordReplaced: true, replayRefused: true, emails: 0 };
  });
  await check('application, Auth, mail and membership counts reconcile', async () => {
    assert.equal(stack.value('select count(*) from public.orgs'), 3);
    assert.equal((await stack.users()).length, 3); assert.equal((await stack.messages()).length, 2);
    assert.equal(stack.mailArtifacts.size, 2); assert.equal(memberCount(stack), 2); assert.equal(auditCount(stack), 2);
    assert.equal(linkAuditCount(stack), 1);
    assert.equal(stack.value('select count(*) from app.agency_bootstrap_invitations where accepted_at is not null'), 2);
    assert.equal(stack.value('select count(*) from app.agency_bootstrap_invitations where accepted_at is null'), 1);
    assert.equal(application.externalRequests, 0); assert.equal(stack.outsideRequests, 0);
    assert.equal(application.browserErrors.length, 0);
    return { agencies: 3, users: 3, emails: 2, memberships: 2, acceptedInvitations: 2, pendingInvitations: 1, acceptanceAudits: 2, linkAudits: 1, externalRequests: 0 };
  });
  evidence.count('browser', browserChecks);
}
