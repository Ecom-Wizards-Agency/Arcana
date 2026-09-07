import { AgencyProvisionRequest, BootstrapRevokeCommand } from '@wizard-ads/shared';
import type { AgencyProvisionRequest as ProvisionRequest } from '@wizard-ads/shared';

export type AgencyCommand =
  | { operation: 'provision'; request: ProvisionRequest; sendEmail: boolean }
  | { operation: 'reissue'; requestId: string; expectedGeneration: number; sendEmail: boolean }
  | { operation: 'revoke'; requestId: string; expectedGeneration: number };

/** Fixed commands and named nonsecret input. Unknown/duplicate flags refuse. */
export function parseAgencyCommand(argv: readonly string[]): AgencyCommand {
  const [operation, ...rest] = argv;
  if (operation !== 'provision' && operation !== 'reissue' && operation !== 'revoke') throw new Error('Choose provision, reissue or revoke.');
  const allowed = new Set(operation === 'provision'
    ? ['--request-id', '--name', '--slug', '--owner-email', '--send-email']
    : operation === 'reissue' ? ['--request-id', '--expected-generation', '--send-email']
      : ['--request-id', '--expected-generation']);
  const values = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (!allowed.has(flag) || values.has(flag)) throw new Error('Unknown or duplicate option.');
    if (flag === '--send-email') values.set(flag, 'true');
    else {
      const value = rest[++i];
      if (!value || value.startsWith('--')) throw new Error('An option value is missing.');
      values.set(flag, value);
    }
  }
  const requestId = values.get('--request-id');
  const sendEmail = values.has('--send-email');
  if (operation === 'provision') {
    return { operation, sendEmail, request: AgencyProvisionRequest.parse({
      requestId, name: values.get('--name'), slug: values.get('--slug'), ownerEmail: values.get('--owner-email'),
    }) };
  }
  const rawGeneration = values.get('--expected-generation');
  if (!rawGeneration || !/^[1-9][0-9]*$/.test(rawGeneration)) throw new Error('Choose the current invitation generation.');
  const request = BootstrapRevokeCommand.parse({ requestId, expectedGeneration: Number(rawGeneration) });
  if (operation === 'reissue' && request.expectedGeneration === 2_147_483_647) throw new Error('Invitation generation is exhausted.');
  return operation === 'reissue' ? { operation, ...request, sendEmail } : { operation, ...request };
}

/** A callback origin must be explicit and cannot contain credentials or a path. */
export function invitationOrigin(raw: string | undefined): string {
  if (!raw) throw new Error('WIZARD_ADS_APP_URL is required for invitation links.');
  const url = new URL(raw);
  if (url.origin !== raw.replace(/\/$/, '') || url.username || url.password ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('Invitation links require an HTTPS origin or a loopback test origin.');
  }
  return url.origin;
}
