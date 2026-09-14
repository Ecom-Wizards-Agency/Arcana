/** Keep the canonical profile on every saved-run link and encode all identities. */
export function optimizerBatchHref(page: 'review' | 'confirm' | 'run', batchId: string, profileId: string, query: Record<string, string> = {}): string {
  const path = ['', 'optimizer', page, encodeURIComponent(batchId)].join('/');
  const params = new URLSearchParams({ profile: profileId, ...query });
  params.set('profile', profileId);
  return `${path}?${params}`;
}

export function optimizerCalculationHref(batchId: string, rowId: string, profileId: string): string {
  const path = ['', 'optimizer', 'review', encodeURIComponent(batchId), 'calculation', encodeURIComponent(rowId)].join('/');
  return `${path}?${new URLSearchParams({ profile: profileId })}`;
}
