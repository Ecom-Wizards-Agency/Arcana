'use server';

import { acceptRecipientInvitation, verifyRecipientInvitation } from '../../../src/invitations/recipient';

export async function acceptAsExistingUser(token: string): Promise<void> {
  return acceptRecipientInvitation('team', token);
}

export async function verifyInvitationEmail(token: string, formData: FormData): Promise<void> {
  return verifyRecipientInvitation('team', token, formData);
}
