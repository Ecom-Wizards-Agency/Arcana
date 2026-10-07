import { CreatorRecordId } from '@wizard-ads/shared';

/** The record id from the path, or null when the path does not carry one in the runner's shape. */
export function creatorRecordParam(value: string | undefined): string | null {
  const parsed = CreatorRecordId.safeParse(value);
  return parsed.success ? parsed.data : null;
}
