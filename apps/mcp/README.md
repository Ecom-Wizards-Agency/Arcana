# Arcana MCP

The production MCP endpoint is a stateless, analytical-read-only view of one
Arcana organization for read keys, and a Creator Connections write surface for
`creator:write` keys. It accepts Streamable HTTP at `POST /mcp`; `GET
/healthz` reports database readiness plus a sanitized Git revision.

The MCP protocol server name is `arcana`. Health retains `service: "openspell"`
and `product: "OpenSpell"` until a separately planned hosted migration. The
`@wizard-ads/*` package scope and `wizardads://` resource URIs remain compatibility
identifiers; changing them
would break installed clients without adding an operator capability.

## Usage

Callers authenticate with a revocable, expiring read key. The key can cover all
profiles in its organization or a fixed profile allowlist. Start with
`wizardads://instructions`, then `list_profiles`; never guess a profile id.

The production catalog contains only these analytical tools:

- `list_profiles`, `get_sync_status`, `get_entity_data`
- `query`, `group_by`, `download_data`
- `get_recommendations`, `get_flags`, `get_pacing`
- `list_experiments`, `get_experiment`

Amazon-write stubs and Arcana mutation tools are deliberately absent from
discovery. There is no environment switch that can add them accidentally.

### The `creator:write` key class

A second, separate key class writes Creator Connections records for the
`amazon-creator-connections` skill. It is not a widened read key: the server
built for it registers only these six tools and its own `wizardads://instructions`,
and the database rechecks the class, expiry, revocation and the issuer's current
owner or admin membership on every call (`app.authorize_mcp_creator_write_key`).
A read key cannot call these tools, and a `creator:write` key cannot call an
analytics tool or read a profile.

| Tool | Takes (the control runner's shapes) | Writes |
|---|---|---|
| `creators.register_record` | one Creator Registry row (`issue_record_id` and later commands) and the `resolve_record` result `register` acted on | the record, its registry-derived history and sample lanes, and the identity rung or the records a conflict named |
| `creators.record_score` | `score` output (`score_record`), the tracker status and the tracker's typed score | the record's qualification and one `score_recorded` entry |
| `creators.append_action` | 1-200 Creator Action Log entries with their own event keys | append-only entries |
| `creators.submit_draft` | one rendered reply for one thread, from an approved template | a draft awaiting an owner's or admin's approval; returns its id |
| `creators.queue_snapshot` | the `queue` command's whole output file | that day's Daily Action Queue |
| `creators.sweep_checkpoint` | the proposed sweep checkpoint (WP-332) | one inbox sweep; Arcana computes whether it reconciled |

Every tool validates with the shared schemas in `packages/shared/src/creators`,
refuses raw contact data by shape (an email, a phone number, a street address or
a link, anywhere in the arguments), and writes through the same upserts, keys and
content digests as `creators:import`, so replays and rows the import already wrote
come back `unchanged`. Its audit row keeps a digest and size of the arguments,
never the arguments. None of it calls Amazon; approving a draft sends nothing.
The full contract a skill author needs is the `wizardads://instructions` resource
served to a `creator:write` key.

Issue one from the CLI (owners and admins only; no profiles):

    pnpm --filter @wizard-ads/mcp keys issue --scope creator:write --org <slug> --owner <user id> --label "creator skill" [--days 30]

## Shape

One authenticated HTTP request creates one MCP server and binds it to a single
organization, key, and profile allowlist. Authentication atomically checks the
token hash, read scope, revocation, and expiry while updating `last_used_at`.
Tools never accept an organization id. Profile reads resolve through the bound
allowlist, so a caller cannot substitute another tenant or profile.

Tool calls and resource list/read operations pass through durable audit wrappers.
Only tool arguments or resource URIs are recorded; transport metadata and bearer
tokens never reach handlers or the audit payload. An audit-write failure fails
the analytical call because an unaudited result cannot support the product's
read-only claim.

The health route runs a database probe. Its response is limited to service and
static product names, version, a validated hexadecimal Git object id (or
`unknown`), and database readiness. Probe errors and configuration values are
not returned.

## Design decision

Three shapes were considered:

- A production/development catalog flag was rejected because one bad environment
  value could re-advertise mutation tools.
- A declarative capability registry was rejected because it added a broad public
  policy layer for a catalog with one valid capability class.
- A single analytical catalog was selected. It hides registration and scope
  policy behind the existing server constructor. Runtime configuration cannot
  add mutation tools.

We accept that mutation-tool protocol sketches are no longer discoverable in
exchange for making the deployed capability claim exact. Amazon changes remain
an operator-approved web-and-worker workflow; MCP cannot approve itself.

Deployment and client configuration are in
[`docs/deploy/mcp-evo.md`](../../docs/deploy/mcp-evo.md).
