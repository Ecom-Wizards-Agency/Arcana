import { CampaignDraft } from '@wizard-ads/shared';

export async function campaignRequest(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const value: unknown = await response.json();
  if (!response.ok) throw new Error(value && typeof value === 'object' && 'error' in value && typeof value.error === 'string' ? value.error : 'The request could not be confirmed. Reload before trying again.');
  return value;
}
export async function draftRequest(body: unknown): Promise<CampaignDraft> {
  return CampaignDraft.parse(await campaignRequest('/api/campaigns/drafts', body));
}
export async function downloadDraft(profileId: string, id: string): Promise<void> {
  const response = await fetch(`/api/campaigns/drafts?${new URLSearchParams({ profileId, id, output: 'xlsx' })}`);
  if (!response.ok) throw new Error('The bulk sheet could not be exported. Reload and review this draft.');
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'campaign-draft.xlsx'; anchor.click();
  URL.revokeObjectURL(url);
}
