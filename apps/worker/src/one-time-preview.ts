import { createHash } from 'node:crypto';
import {
  type OneTimeRpcConfiguration,
  OneTimeRpcPreviewRequest,
  OneTimeRpcSnapshot,
  Uuid,
} from '@wizard-ads/shared';
import { profileToday } from './profile-calendar.js';

/** Canonical schema parsing fixes object key order; scope order is not identity. */
export function oneTimePreviewRequestFingerprint(
  orgId: string,
  actorId: string,
  request: OneTimeRpcPreviewRequest,
): string {
  const parsed = OneTimeRpcPreviewRequest.parse(request);
  const scope = parsed.scope.mode === 'all'
    ? parsed.scope
    : { mode: parsed.scope.mode, campaignIds: [...parsed.scope.campaignIds].sort() };
  return fingerprint('openspell.one-time-rpc.request.v1', {
    orgId: Uuid.parse(orgId).toLowerCase(),
    actorId: Uuid.parse(actorId).toLowerCase(),
    profileId: parsed.profileId.toLowerCase(),
    scope,
    configuration: parsed.configuration,
  });
}

export function freezeOneTimeRpcSnapshot(
  configuration: OneTimeRpcConfiguration,
  profileTimezone: string,
  admittedAt: Date,
): OneTimeRpcSnapshot {
  // Legacy calendars tolerate bad stored timezones by using UTC. A confirmed
  // one-time window must refuse that ambiguity instead of changing its meaning.
  new Intl.DateTimeFormat('en', { timeZone: profileTimezone }).format(admittedAt);
  return OneTimeRpcSnapshot.parse({
    version: 1,
    configuration,
    profileTimezone,
    admittedAt: admittedAt.toISOString(),
    profileToday: profileToday(profileTimezone, admittedAt),
  });
}

export function oneTimeRpcSnapshotFingerprint(snapshot: OneTimeRpcSnapshot): string {
  const parsed = OneTimeRpcSnapshot.parse(snapshot);
  const settings = parsed.configuration;
  const values = [
    String(parsed.version), String(settings.version), settings.method,
    numberBits(settings.targetAcos), numberBits(settings.bidFloor), numberBits(settings.bidCeiling),
    numberBits(settings.bidIncreaseCap), numberBits(settings.bidDecreaseCap),
    settings.window.start, settings.window.end,
    parsed.profileTimezone, parsed.admittedAt, parsed.profileToday,
  ];
  const hash = createHash('sha256').update('openspell.one-time-rpc.snapshot.v1\n');
  for (const value of values) hash.update(`${Buffer.byteLength(value, 'utf8')}:${value}\n`);
  return hash.digest('hex');
}

/** Derived compatibility metadata only; never use it to recalculate v2 dates. */
export function oneTimeRpcWindowDays(snapshot: OneTimeRpcSnapshot): number {
  const { start, end } = OneTimeRpcSnapshot.parse(snapshot).configuration.window;
  return (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000 + 1;
}

function fingerprint(domain: string, value: unknown): string {
  return createHash('sha256').update(domain).update('\n').update(JSON.stringify(value)).digest('hex');
}

/** PostgreSQL float8send uses the same big-endian IEEE 754 representation. */
function numberBits(value: number): string {
  const bytes = Buffer.alloc(8);
  bytes.writeDoubleBE(value === 0 ? 0 : value);
  return bytes.toString('hex');
}
