'use server';

import { acceptRecipientInvitation, verifyRecipientInvitation } from '../../../src/invitations/recipient';

export async function acceptOwnerInvitation(token: string): Promise<void> {
  return acceptRecipientInvitation('agency', token);
}

export async function verifyOwnerInvitationEmail(token: string, formData: FormData): Promise<void> {
  return verifyRecipientInvitation('agency', token, formData);
}
