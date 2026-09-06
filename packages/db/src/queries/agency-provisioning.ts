import {
  AgencyProvisionCommand, AgencyProvisionReceipt, BootstrapReissueCommand, BootstrapRevokeCommand,
  BootstrapDeliveryContext, BootstrapTokenDigest, Uuid,
} from '@wizard-ads/shared';
import type { QueryHandle } from '../client.js';

/** Infrastructure-only command. An agency owner/admin has no provisioning authority. */
export async function provisionAgency(handle: QueryHandle, raw: AgencyProvisionCommand): Promise<AgencyProvisionReceipt> {
  const input = AgencyProvisionCommand.parse(raw);
  const rows = await handle.sql<{ receipt: unknown }[]>`
    select app.provision_agency(${input.requestId},${input.name},${input.slug},${input.ownerEmail},
      ${input.token.tokenHash},${input.token.tokenPrefix}) as receipt
  `;
  if (rows.length !== 1) throw new Error('Agency provisioning response count mismatch');
  return AgencyProvisionReceipt.parse(rows[0]!.receipt);
}

export async function reissueAgencyBootstrapInvitation(
  handle: QueryHandle, raw: BootstrapReissueCommand,
): Promise<AgencyProvisionReceipt> {
  const input = BootstrapReissueCommand.parse(raw);
  const rows = await handle.sql<{ receipt: unknown }[]>`
    select app.reissue_bootstrap_invitation(${input.requestId},${input.expectedGeneration},
      ${input.token.tokenHash},${input.token.tokenPrefix}) as receipt
  `;
  if (rows.length !== 1) throw new Error('Invitation reissue response count mismatch');
  return AgencyProvisionReceipt.parse(rows[0]!.receipt);
}

export async function revokeAgencyBootstrapInvitation(handle: QueryHandle, raw: BootstrapRevokeCommand): Promise<boolean> {
  const input = BootstrapRevokeCommand.parse(raw);
  const rows = await handle.sql<{ changed: boolean }[]>`
    select app.revoke_bootstrap_invitation(${input.requestId},${input.expectedGeneration}) as changed
  `;
  if (rows.length !== 1 || typeof rows[0]!.changed !== 'boolean') throw new Error('Invitation revocation response mismatch');
  return rows[0]!.changed;
}

/** No caller-supplied email can redirect a saved owner's Auth invitation. */
export async function agencyBootstrapDeliveryContext(
  handle: QueryHandle, rawRequestId: string, rawTokenHash: string,
): Promise<BootstrapDeliveryContext> {
  const requestId = Uuid.parse(rawRequestId);
  const tokenHash = BootstrapTokenDigest.shape.tokenHash.parse(rawTokenHash);
  const rows = await handle.sql<{ context: unknown }[]>`
    select app.bootstrap_delivery_context(${requestId},${tokenHash}) as context
  `;
  if (rows.length !== 1) throw new Error('Invitation delivery response count mismatch');
  return BootstrapDeliveryContext.parse(rows[0]!.context);
}
