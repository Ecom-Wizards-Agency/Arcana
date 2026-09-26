import { createDb } from '@wizard-ads/db';
import { invitationOrigin, parseAgencyCommand } from './command.js';
import { authInvitationLinker, authInvitationSender, runAgencyCommand } from './operator.js';

const HELP = `Provision an agency without joining it:
  agency provision --request-id UUID --name NAME --slug SLUG --owner-email EMAIL [--send-email]
  agency reissue --request-id UUID --expected-generation N [--send-email]
  agency revoke --request-id UUID --expected-generation N

Inject OPENSPELL_OPERATOR_DATABASE_URL from the installation secret store.
Invitation links require WIZARD_ADS_APP_URL. With OPENSPELL_OPERATOR_AUTH_URL and
OPENSPELL_OPERATOR_AUTH_KEY, the printed link also activates a new account (link
delivery, the default; nothing is emailed). --send-email instead asks Auth to
email it, which needs working SMTP and the invite template. Output links are
private and shown once.
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { process.stdout.write(HELP); return; }
  const command = parseAgencyCommand(args);
  const connectionString = process.env['OPENSPELL_OPERATOR_DATABASE_URL'];
  if (!connectionString) throw new Error('OPENSPELL_OPERATOR_DATABASE_URL is required.');
  const appOrigin = command.operation === 'revoke' ? undefined : invitationOrigin(process.env['WIZARD_ADS_APP_URL']);
  const sendEmail = command.operation !== 'revoke' && command.sendEmail;
  const authUrl = process.env['OPENSPELL_OPERATOR_AUTH_URL'];
  const authKey = process.env['OPENSPELL_OPERATOR_AUTH_KEY'];
  if (sendEmail && (!authUrl || !authKey)) throw new Error('Operator Auth delivery configuration is required.');
  const sender = sendEmail ? authInvitationSender(authUrl!, authKey!) : undefined;
  const linker = command.operation !== 'revoke' && !sendEmail && authUrl && authKey
    ? authInvitationLinker(authUrl, authKey) : undefined;
  const handle = createDb({ connectionString, max: 1, statementTimeoutSeconds: 20 });
  try {
    const result = await runAgencyCommand(command, {
      handle, ...(appOrigin ? { appOrigin } : {}), ...(sender ? { sendInvitation: sender } : {}),
      ...(linker ? { issueLink: linker } : {}),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if ('delivery' in result && ['failed', 'uncertain', 'unavailable', 'token_unavailable'].includes(result.delivery)) process.exitCode = 2;
  } finally {
    await handle.close();
  }
}

void main().catch(() => {
  // SQL/provider errors can include credentials or bearer tokens. Keep them out
  // of terminal logs. A retry with the same request ID reconciles provision state.
  process.stderr.write('Agency command could not be completed. Check the command and installation configuration. Reuse the request ID to reconcile provisioning; do not assume an uncertain request failed.\n');
  process.exitCode = 1;
});
