import { z } from 'zod';
import { AmazonConnectionBegin, AmazonConnectionSubmit } from './amazon-connections.js';
import { Region, Uuid } from './primitives.js';
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

/** Deployment application identity is independent of the consenting seller. */
export const SpApiDeployment = AmazonConnectionBegin.pick({ clientId: true, redirectUri: true }).extend({
  applicationId: z.string().trim().min(1).max(256),
  region: Region,
}).strict();
export type SpApiDeployment = z.infer<typeof SpApiDeployment>;
export const SpApiProfileSelection = z.object({
  profileId: Uuid.transform((value) => value.toLowerCase()),
  marketplaceId: z.string().regex(/^[A-Z0-9]{1,64}$/),
}).strict();
export type SpApiProfileSelection = z.infer<typeof SpApiProfileSelection>;
export const SpApiConnectionBegin = AmazonConnectionBegin.pick({ requestId: true, nonceHash: true })
  .extend(SpApiDeployment.shape).extend({
  label: z.string().trim().min(1).max(256),
  bindings: z.array(SpApiProfileSelection).min(1).max(50)
    .refine((rows) => new Set(rows.map((row) => row.profileId)).size === rows.length, 'Duplicate profiles'),
}).strict();
export type SpApiConnectionBegin = z.infer<typeof SpApiConnectionBegin>;
/** Only a verified SP callback may supply these provider-returned values. */
export const SpApiConnectionSubmit = AmazonConnectionSubmit.extend({
  code: AmazonConnectionSubmit.shape.code.refine((value) => value.trim().length > 0, 'Missing consent code'),
  sellingPartnerId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/),
}).strict();
export type SpApiConnectionSubmit = z.infer<typeof SpApiConnectionSubmit>;
/** Public callback outcomes contain only fixed reason codes, never provider text. */
export const SpApiConsentRefusal = z.enum([
  'missing', 'mismatch', 'expired', 'not_yet_valid', 'reused', 'wrong_actor',
  'authority_changed', 'operation_not_pending', 'invalid_consent', 'not_configured',
  'submission_uncertain', 'provider_refused',
]);
export type SpApiConsentRefusal = z.infer<typeof SpApiConsentRefusal>;
/**
 * Consent-start refusal classes. They never share a value with a callback
 * refusal, so one `spapi_error` query parameter can carry either.
 */
export const SpApiStartRefusalClass = z.enum([
  'origin', 'unavailable', 'session', 'role', 'configuration', 'selection', 'signing_key', 'database', 'unexpected',
]);
export type SpApiStartRefusalClass = z.infer<typeof SpApiStartRefusalClass>;
/**
 * A deployment setting's name, never its value. The web runtime that reads the
 * settings owns the exact allowlist: worker artifacts bundle this package and
 * refuse provider setting names.
 */
export const SpApiStartSetting = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
export type SpApiStartSetting = z.infer<typeof SpApiStartSetting>;
/** The submitted form part a selection refusal names; `form` is an oversized submission. */
export const SpApiStartField = z.enum(['org', 'label', 'bindings', 'form']);
export type SpApiStartField = z.infer<typeof SpApiStartField>;
/** Exact `raise exception` refusals of `app.begin_spapi_connection` and its manager lock. */
export const SpApiStartDatabaseRefusal = z.enum([
  'manager_required', 'invalid_installation', 'request_reused', 'invalid_selection', 'duplicate_profiles',
  'association_refused', 'reconnect_scope', 'reconnect_bindings', 'profile_taken',
]);
export type SpApiStartDatabaseRefusal = z.infer<typeof SpApiStartDatabaseRefusal>;
/** One refusal and its only admissible detail; unlisted database errors carry none. */
export const SpApiStartRefusal = z.discriminatedUnion('refusal', [
  z.object({ refusal: z.literal('configuration'), detail: SpApiStartSetting }).strict(),
  z.object({ refusal: z.literal('selection'), detail: SpApiStartField }).strict(),
  z.object({ refusal: z.literal('database'), detail: SpApiStartDatabaseRefusal.nullable() }).strict(),
  z.object({ refusal: z.enum(['origin', 'unavailable', 'session', 'role', 'signing_key', 'unexpected']), detail: z.null() }).strict(),
]);
export type SpApiStartRefusal = z.infer<typeof SpApiStartRefusal>;
export const SpApiConnectionOperation = z.object({
  operationId: Uuid, orgId: Uuid, connectionId: Uuid.nullable(),
  state: z.enum(['awaiting_consent', 'queued', 'exchanging', 'completed', 'reconnect_required', 'cancelled']),
  reason: z.enum(['not_configured', 'exchange_uncertain', 'exchange_refused', 'authority_changed', 'expired', 'operator_cancelled']).nullable(),
  requestedBindings: z.number().int().min(0).max(50),
  attachedBindings: z.number().int().min(0).max(50),
  createdAt: z.iso.datetime({ offset: true }), updatedAt: z.iso.datetime({ offset: true }),
}).strict();
export type SpApiConnectionOperation = z.infer<typeof SpApiConnectionOperation>;
/** An owner or admin switches weekly SP-API reporting for one profile binding. */
export const SpApiBindingReportingRequest = z.object({ enabled: z.boolean() }).strict();
export type SpApiBindingReportingRequest = z.infer<typeof SpApiBindingReportingRequest>;
/**
 * One profile binding's saved reporting state. `enabledAt` is null when reporting is
 * disabled, and also for a binding enabled before its start date was recorded.
 */
export const SpApiProfileBindingState = z.object({
  bindingId: Uuid, connectionId: Uuid, profileId: Uuid,
  profileName: z.string().min(1).max(512),
  marketplaceId: SpApiProfileSelection.shape.marketplaceId,
  enabled: z.boolean(),
  enabledAt: z.iso.datetime({ offset: true }).nullable(),
  profileSyncEnabled: z.boolean(),
}).strict().refine((state) => state.enabled || state.enabledAt === null, 'A disabled binding has no reporting start');
export type SpApiProfileBindingState = z.infer<typeof SpApiProfileBindingState>;
export const SpApiConnectionInstallation = SpApiConnectionBegin.omit({ requestId: true, nonceHash: true });
export type SpApiConnectionInstallation = z.infer<typeof SpApiConnectionInstallation>;
export const SpApiConnectionClaim = z.object({
  operation: SpApiConnectionOperation,
  leaseId: Uuid,
  installation: SpApiConnectionInstallation,
  sellingPartnerId: SpApiConnectionSubmit.shape.sellingPartnerId,
  code: z.string().min(1).max(8192),
}).strict();
export type SpApiConnectionClaim = z.infer<typeof SpApiConnectionClaim>;

/** Worker transaction context; never contains a credential or a Vault pointer. */
export const SpApiAttachmentContext = z.object({
  operation: SpApiConnectionOperation,
  installation: SpApiConnectionInstallation,
  sellingPartnerId: SpApiConnectionSubmit.shape.sellingPartnerId,
  targetConnectionId: Uuid.nullable(),
}).strict();
export type SpApiAttachmentContext = z.infer<typeof SpApiAttachmentContext>;

export class NotConfigured extends Error {
  readonly provider = 'amazon_spapi';
  readonly kind = 'not_configured';
  readonly retryable = false;
  readonly retryAfterSeconds = undefined;
  override readonly name = 'NotConfigured';
  constructor() { super('SP-API authorization code exchange is not configured'); }
}
