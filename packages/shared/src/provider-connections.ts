import { z } from 'zod';
import { AmazonConnectionBegin, AmazonConnectionSubmit } from './amazon-connections.js';
import { Uuid } from './primitives.js';
import type { OrgActor } from './agency.js';

export const ConnectionProvider = z.enum(['amazon_ads', 'amazon_spapi']);
export type ConnectionProvider = z.infer<typeof ConnectionProvider>;
export const ProviderConnectionHealth = z.object({
  connectionId: Uuid,
  state: z.enum(['pending', 'active', 'revoked', 'error']),
  hasCredential: z.boolean(),
});
export type ProviderConnectionHealth = z.infer<typeof ProviderConnectionHealth>;

/** Application operations own admission; only the worker receives custody capability. */
export interface ProviderConnectionLifecycle<Begin, Submission, Operation, Claim> {
  readonly provider: ConnectionProvider;
  readonly custody: ProviderConnectionCustody<Claim, Operation>;
  begin(actor: OrgActor, input: Begin): Promise<Operation>;
  submit(actor: OrgActor, input: Submission): Promise<Operation>;
  cancel(actor: OrgActor, operationId: string): Promise<Operation>;
  operation(actor: OrgActor, operationId: string): Promise<Operation | null>;
  revoke(actor: OrgActor, connectionId: string): Promise<ProviderConnectionHealth | null>;
  health(actor: OrgActor, connectionId: string): Promise<ProviderConnectionHealth | null>;
}

/** One-use grant exchange. The claim never crosses the application admission interface. */
export interface ProviderConnectionCustody<Claim, Operation> {
  claim(leaseId: string): Promise<Claim | null>;
  read(operationId: string): Promise<Operation>;
  attach(operationId: string, leaseId: string, refreshToken: string): Promise<Operation>;
}

export const SpApiConnectionBegin = AmazonConnectionBegin.omit({ scope: true }).extend({
  label: z.string().trim().min(1).max(256),
  sellingPartnerId: z.string().trim().min(1).max(256),
  marketplaceIds: z.array(z.string().trim().min(1).max(64)).min(1).max(50)
    .refine((ids) => new Set(ids).size === ids.length, 'Duplicate marketplaces'),
});
export type SpApiConnectionBegin = z.infer<typeof SpApiConnectionBegin>;
export const SpApiConnectionSubmit = AmazonConnectionSubmit;
export type SpApiConnectionSubmit = z.infer<typeof SpApiConnectionSubmit>;
export const SpApiConnectionOperation = z.object({
  operationId: Uuid, orgId: Uuid, connectionId: Uuid.nullable(),
  state: z.enum(['awaiting_consent', 'queued', 'exchanging', 'completed', 'reconnect_required', 'cancelled']),
  reason: z.enum(['not_configured', 'exchange_uncertain', 'exchange_refused', 'authority_changed', 'expired', 'operator_cancelled']).nullable(),
  createdAt: z.iso.datetime({ offset: true }), updatedAt: z.iso.datetime({ offset: true }),
}).strict();
export type SpApiConnectionOperation = z.infer<typeof SpApiConnectionOperation>;
export const SpApiConnectionInstallation = SpApiConnectionBegin.omit({ requestId: true, nonceHash: true });
export type SpApiConnectionInstallation = z.infer<typeof SpApiConnectionInstallation>;
export const SpApiConnectionClaim = z.object({
  operation: SpApiConnectionOperation,
  leaseId: Uuid,
  installation: SpApiConnectionInstallation,
  code: z.string().min(1).max(8192),
}).strict();
export type SpApiConnectionClaim = z.infer<typeof SpApiConnectionClaim>;

export class NotConfigured extends Error {
  readonly provider = 'amazon_spapi';
  readonly kind = 'not_configured';
  readonly retryable = false;
  readonly retryAfterSeconds = undefined;
  override readonly name = 'NotConfigured';
  constructor() { super('SP-API authorization code exchange is not configured'); }
}
