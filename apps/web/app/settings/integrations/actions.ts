'use server';

/**
 * One-time credential writes for `/settings/integrations`.
 *
 * Page controls are presentation. Complete database operations lock current
 * authority before changing custody or competitor links. Submitted credentials
 * are never returned, logged, or copied into error metadata.
 */
import { revalidatePath } from 'next/cache';
import {
  INTEGRATION_PROVIDERS,
  createCompetitorLink,
  connectIntegrationCredentialForActor,
  revokeIntegrationCredentialForActor,
  removeCompetitorLink,
  withAuthenticatedOrgEditor,
} from '@wizard-ads/db';
import type { IntegrationProvider } from '@wizard-ads/db';
import { Uuid } from '@wizard-ads/shared';
import { authorize } from '../../../src/auth/roles';
import { gateAction } from '../../../src/auth/guard';

const SETTINGS_PATH = '/settings/integrations';

export async function connectIntegration(formData: FormData): Promise<void> {
  const { handle, active, userId } = await gateAction();
  authorize(active.role, 'manageConnection');

  const provider = requireProvider(formData.get('provider'));
  const label = optionalLabel(formData.get('label')) ?? 'Default';
  const value = requireSecret(formData.get('secret'));
  await connectIntegrationCredentialForActor(handle, { orgId: active.orgId, userId }, { provider, label }, value);

  revalidatePath(SETTINGS_PATH);
}

export async function revokeIntegration(formData: FormData): Promise<void> {
  const { handle, active, userId } = await gateAction();
  authorize(active.role, 'manageConnection');

  const connectionId = requireId(formData.get('connectionId'));
  await revokeIntegrationCredentialForActor(handle, { orgId: active.orgId, userId }, connectionId);
  revalidatePath(SETTINGS_PATH);
}

export async function addCompetitorLink(formData: FormData): Promise<void> {
  const { handle, active, userId } = await gateAction();
  authorize(active.role, 'editTargets');
  const details = {
    profileId: requireId(formData.get('profileId')),
    ourAsin: requireAsin(formData.get('ourAsin')),
    competitorAsin: requireAsin(formData.get('competitorAsin')),
  };
  await withAuthenticatedOrgEditor(handle, { orgId: active.orgId, userId }, (context) =>
    createCompetitorLink(context, { ...details, orgId: context.actor.orgId }));
  revalidatePath(SETTINGS_PATH);
}

export async function deleteCompetitorLink(formData: FormData): Promise<void> {
  const { handle, active, userId } = await gateAction();
  authorize(active.role, 'editTargets');
  const id = requireId(formData.get('linkId'));
  await withAuthenticatedOrgEditor(handle, { orgId: active.orgId, userId }, (context) =>
    removeCompetitorLink(context, { orgId: context.actor.orgId, id }));
  revalidatePath(SETTINGS_PATH);
}

function requireProvider(value: FormDataEntryValue | null): IntegrationProvider {
  if (
    typeof value !== 'string' ||
    !(INTEGRATION_PROVIDERS as readonly string[]).includes(value)
  ) {
    throw new Error('Unknown integration provider');
  }
  return value as IntegrationProvider;
}

function requireId(value: FormDataEntryValue | null): string {
  const parsed = Uuid.safeParse(value);
  if (!parsed.success) throw new Error('Invalid integration resource identifier');
  return parsed.data;
}

function optionalLabel(value: FormDataEntryValue | null): string | null {
  if (typeof value !== 'string') return null;
  const label = value.trim();
  return label.length === 0 ? null : label;
}

function requireSecret(value: FormDataEntryValue | null): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Enter an API credential');
  }
  return value;
}

function requireAsin(value: FormDataEntryValue | null): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9]{10}$/.test(value.trim())) {
    throw new Error('Enter a 10-character ASIN');
  }
  return value.trim().toUpperCase();
}
