# Undesigned routes

WP-272 uses shell typography, theme tokens and existing interaction controls. These routes need dedicated light and dark frames. Keep this record outside the public repository.

| Route | Frame needed |
| --- | --- |
| /settings/account | Password, MFA and passkey cards beneath the five Settings tabs, including enrollment and policy gates. |
| /settings/profiles | Profile roster, bulk sync selection, schedules and target forms with role and pending states. |
| /settings/connections | Amazon connection status table, OAuth progress and recovery, profile-region summary and unavailable providers. |
| /settings/members | Member and invitation rosters with role editing, ownership transfer and access refusal. |
| /settings/integrations | Provider credential cards, connection health, revoke action and competitor-product pair mapping. |
| /bugs | Vote-ordered status columns, triage controls and declined or duplicate reports. |
| /roadmap | Feature status columns, votes, request action and not-planned disclosure. |
| /feedback | Brief transition preserving legacy report fragments before opening Bugs or Roadmap. |
| /feedback/new | Bug or feature submission form, supplied context and validation or submission errors. |
| /tags | Nested taxonomy, color picker, campaign assignments, reusable filters and sharing. |
| /crosscheck | Daily and campaign-week comparison tables with coverage, missing evidence and verdict detail. |
| /sync-status | Profile freshness, jobs, report lifecycle and row-accounting tables with missing measurements. |
| /connect-claude | MCP endpoint instructions, scoped key creation, one-time key display, expiry and revocation. |
| /experiments | Experiment roster, status filters and proposed tests beside the Timeline navigation. |
| /experiments/new | Confirm the Timeline experiment-creation frame against validation, scope loading and access failures. |
| /experiments/[experimentId] | Extend the Timeline detail frame for missing measurements, empty changes and read failures. |
| /recommendations | Full review grid with provenance, selection, explicit decision confirmation and resulting status. |

## Deferred surfaces completed alongside these routes

- Target 360 uses its descriptor title in the topbar.
- The Targets product-assignment modal lists multi-product ad groups, their measured spend and advertised ASIN choices. Assignments affect unresolved banner counts; product performance aggregation needs a separate grid change.
- Timeline’s package import remains pending: its functions are not exported by the core entry point, which is outside the supplied allowlist.

## Remaining source boundaries

The physical experiment-detail loading and error adapters live under `app/(experiment-detail)`, outside the supplied file allowlist. Their shared boundaries remain unchanged.
