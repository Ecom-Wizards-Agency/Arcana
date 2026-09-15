import { z } from 'zod';

/** Retry policy travels with the failure, never with an importing caller. */
export const ProviderFailure = z.object({
  retryable: z.boolean(),
  retryAfterSeconds: z.number().finite().nonnegative().optional(),
  provider: z.string().min(1),
  kind: z.string().min(1),
});
export type ProviderFailure = z.infer<typeof ProviderFailure>;

export function isProviderFailure(value: unknown): value is ProviderFailure {
  return ProviderFailure.safeParse(value).success;
}

/** Unclassified exceptions retain the queue's bounded retry policy. */
export function isPermanentProviderFailure(value: unknown): boolean {
  return isProviderFailure(value) && !value.retryable;
}
