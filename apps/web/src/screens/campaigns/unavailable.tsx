import { Notice } from './ui';

export const CAMPAIGN_UNAVAILABLE_COPY = {
  campaigns: {
    empty: ['No products available to build with', 'Connect a profile and sync its advertised products, then choose products for your first draft.', 'Connections', '/settings/connections'],
    gated: ['Campaign builder access is restricted', 'Ask an organization owner or administrator for access to this profile before preparing campaign drafts.', 'Review organization access', '/settings/members'],
    'not-measured': ['Campaign planning evidence is unavailable', 'The selected profile has no usable planning measurement yet. Check sync status; missing bids and rules are not treated as zero.', 'Check connections and sync', '/settings/connections'],
  },
  'campaigns-draft': {
    empty: ['No campaign draft to review', 'Save a draft in the builder, then open it as the operator who saved it. A missing or inaccessible draft has no validated values.', 'Create a campaign draft', '/campaigns'],
    gated: ['Campaign draft access is restricted', 'This operator cannot review or edit this draft. Ask an organization owner or administrator to check your profile access.', 'Review organization access', '/settings/members'],
    'not-measured': ['Draft validation evidence is unavailable', 'The required checks have no recorded measurement for this draft. Return to the builder and review its profile, products and rules before validating again.', 'Return to builder', '/campaigns'],
  },
  'campaigns-assets': {
    empty: ['No creative library is connected', 'Select a connected profile to read its saved asset-library observations. Refresh from Amazon becomes available in that profile’s library.', 'Connect a profile', '/settings/connections'],
    gated: ['Creative library access is restricted', 'Ask an organization owner or administrator for profile access. Refreshing the library also requires editing permission.', 'Review organization access', '/settings/members'],
    'not-measured': ['Creative observations are not measured', 'No usable asset observation is available. Check profile sync before requesting a library refresh; asset processing does not establish moderation approval.', 'Check connections and sync', '/settings/connections'],
  },
  'campaigns-naming': {
    empty: ['No profile for naming conventions', 'Connect a profile, then save a convention or copy an existing convention within this organization.', 'Connect a profile', '/settings/connections'],
    gated: ['Naming convention access is restricted', 'Ask an organization owner or administrator for access. Saving or copying a convention requires editing permission.', 'Review organization access', '/settings/members'],
    'not-measured': ['Naming convention usage is not measured', 'Profile strategy evidence is unavailable, so usage counts and the active convention cannot be confirmed. Review the profile before copying a convention.', 'Review connected profiles', '/settings/connections'],
  },
  'campaigns-eligibility': {
    empty: ['No profile to check for eligibility', 'Select a connected profile and save a draft to check its budget, name, exposure and supported controls.', 'Create a campaign draft', '/campaigns'],
    gated: ['Eligibility checks require profile access', 'Ask an organization owner or administrator for profile access. The table describes check sources; it does not confirm eligibility for this operator.', 'Review organization access', '/settings/members'],
    'not-measured': ['Eligibility evidence is not measured', 'Profile rules and mirror evidence are unavailable. Restore those sources before validating a draft; no check shown here has passed.', 'Check connections and sync', '/settings/connections'],
  },
  'campaigns-update': {
    empty: ['No profile for an update recipe', 'Connect and sync a profile before selecting existing campaigns for a bulk update sheet.', 'Connect a profile', '/settings/connections'],
    gated: ['Campaign update access is restricted', 'Ask an organization owner or administrator for access to the profile whose campaigns you want to update.', 'Review organization access', '/settings/members'],
    'not-measured': ['Campaign mirror values are not measured', 'An update needs the current synced campaign values. Check sync status before preparing sparse bulk update rows.', 'Check connections and sync', '/settings/connections'],
  },
} as const;

export function CampaignUnavailable({ screen, data }: {
  screen: keyof typeof CAMPAIGN_UNAVAILABLE_COPY;
  data: { view: 'empty' | 'gated' | 'not-measured' | 'error'; message: string };
}) {
  if (data.view === 'error') return <Notice kind="bad">{data.message}</Notice>;
  const [title, explanation, action, href] = CAMPAIGN_UNAVAILABLE_COPY[screen][data.view];
  return <section className="wa-stack"><Notice><strong>{title}</strong><p>{explanation}</p>{data.message && data.message !== explanation && <p className="wa-hint">{data.message}</p>}</Notice><a href={href}>{action}</a></section>;
}
