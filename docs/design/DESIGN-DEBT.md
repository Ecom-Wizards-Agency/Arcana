# Undesigned routes

WP-272 uses shell typography, theme tokens and existing interaction controls. These routes need dedicated light and dark frames. Capture files remain in the ignored browser-artifact directory.

| Route | Frame needed | Live references |
| --- | --- | --- |
| /settings/account | Password, MFA and passkey cards beneath the five Settings tabs, including enrollment and policy gates. | [Light](../../apps/web/node_modules/.cache/playwright/wp272-live/settings-account-light.png) · [Dark](../../apps/web/node_modules/.cache/playwright/wp272-live/settings-account-dark.png) |
| /settings/profiles | Profile roster, bulk sync selection, schedules and target forms with role and pending states. | [Light](../../apps/web/node_modules/.cache/playwright/wp272-live/settings-profiles-light.png) · [Dark](../../apps/web/node_modules/.cache/playwright/wp272-live/settings-profiles-dark.png) |
| /settings/connections | Amazon connection status table, OAuth progress and recovery, profile-region summary and unavailable providers. | [Light](../../apps/web/node_modules/.cache/playwright/wp272-live/settings-connections-light.png) · [Dark](../../apps/web/node_modules/.cache/playwright/wp272-live/settings-connections-dark.png) |
| /settings/members | Member and invitation rosters with role editing, ownership transfer and access refusal. | [Light](../../apps/web/node_modules/.cache/playwright/wp272-live/settings-members-light.png) · [Dark](../../apps/web/node_modules/.cache/playwright/wp272-live/settings-members-dark.png) |
| /settings/integrations | Provider credential cards, connection health, revoke action and competitor-product pair mapping. | [Light](../../apps/web/node_modules/.cache/playwright/wp272-live/settings-integrations-light.png) · [Dark](../../apps/web/node_modules/.cache/playwright/wp272-live/settings-integrations-dark.png) |
| /bugs | Vote-ordered status columns, triage controls and declined or duplicate reports. | [Light](../../apps/web/node_modules/.cache/playwright/wp272-live/bugs-light.png) · [Dark](../../apps/web/node_modules/.cache/playwright/wp272-live/bugs-dark.png) |
| /roadmap | Feature status columns, votes, request action and not-planned disclosure. | [Light](../../apps/web/node_modules/.cache/playwright/wp272-live/roadmap-light.png) · [Dark](../../apps/web/node_modules/.cache/playwright/wp272-live/roadmap-dark.png) |
| /feedback | Brief transition preserving legacy report fragments before opening Bugs or Roadmap. | [Light](../../apps/web/node_modules/.cache/playwright/wp272-live/feedback-light.png) · [Dark](../../apps/web/node_modules/.cache/playwright/wp272-live/feedback-dark.png) |
| /feedback/new | Bug or feature submission form, supplied context and validation or submission errors. | [Light](../../apps/web/node_modules/.cache/playwright/wp272-live/feedback-new-light.png) · [Dark](../../apps/web/node_modules/.cache/playwright/wp272-live/feedback-new-dark.png) |
| /tags | Nested taxonomy, color picker, campaign assignments, reusable filters and sharing. | [Light](../../apps/web/node_modules/.cache/playwright/wp272-live/tags-light.png) · [Dark](../../apps/web/node_modules/.cache/playwright/wp272-live/tags-dark.png) |
| /crosscheck | Daily and campaign-week comparison tables with coverage, missing evidence and verdict detail. | [Light](../../apps/web/node_modules/.cache/playwright/wp272-live/crosscheck-light.png) · [Dark](../../apps/web/node_modules/.cache/playwright/wp272-live/crosscheck-dark.png) |
| /sync-status | Profile freshness, jobs, report lifecycle and row-accounting tables with missing measurements. | [Light](../../apps/web/node_modules/.cache/playwright/wp272-live/sync-status-light.png) · [Dark](../../apps/web/node_modules/.cache/playwright/wp272-live/sync-status-dark.png) |
| /connect-claude | MCP endpoint instructions, scoped key creation, one-time key display, expiry and revocation. | [Light](../../apps/web/node_modules/.cache/playwright/wp272-live/connect-claude-light.png) · [Dark](../../apps/web/node_modules/.cache/playwright/wp272-live/connect-claude-dark.png) |
| /experiments | Experiment roster, status filters and proposed tests beside the Timeline navigation. | [Light](../../apps/web/node_modules/.cache/playwright/wp272-live/experiments-light.png) · [Dark](../../apps/web/node_modules/.cache/playwright/wp272-live/experiments-dark.png) |
| /experiments/new | Confirm the Timeline experiment-creation frame against validation, scope loading and access failures. | [Light](../../apps/web/node_modules/.cache/playwright/wp272-live/experiments-new-light.png) · [Dark](../../apps/web/node_modules/.cache/playwright/wp272-live/experiments-new-dark.png) |
| /experiments/[experimentId] | Extend the Timeline detail frame for missing measurements, empty changes and read failures. | [Light](../../apps/web/node_modules/.cache/playwright/wp272-live/experiments-experimentId-light.png) · [Dark](../../apps/web/node_modules/.cache/playwright/wp272-live/experiments-experimentId-dark.png) |
| /recommendations | Full review grid with provenance, selection, explicit decision confirmation and resulting status. | [Light](../../apps/web/node_modules/.cache/playwright/wp272-live/recommendations-light.png) · [Dark](../../apps/web/node_modules/.cache/playwright/wp272-live/recommendations-dark.png) |

## Deferred surfaces completed alongside these routes

- Target 360 uses its descriptor title in the topbar.
- The Targets product-assignment modal lists multi-product ad groups, their measured spend and advertised ASIN choices. Assignments affect unresolved banner counts; product performance aggregation needs a separate grid change.
- Timeline imports its functions from the generated core entry point. The import rule has no Timeline exception.
- Experiment-detail loading and error boundaries use the same ScreenSurface and EmptyState presentation as the other routes.

## Accepted design debt

Utility rosters remain semantic HTML tables with the shell's styling. Dedicated frames should retain their form controls and row relationships.

Each live reference uses a signed-in actor, a selected profile and a 1440 × 1024 viewport. Feedback has no stable ready screen: its reference captures the real server-rendered redirect bridge before hydration. The state render artifacts remain separate from these live references.
