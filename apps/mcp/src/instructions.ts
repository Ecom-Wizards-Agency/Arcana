/**
 * The bootstrap document, served as `wizardads://instructions`.
 *
 * It exists because half of what makes an ads number wrong is not in the data
 * and not in the schema: zero-impression rows are absent rather than zero,
 * same-day sales are still attributing, ratios must never be averaged, and a
 * profile id that is not actually applied as a predicate is the single bug this
 * server was built not to repeat. A client that reads this first asks better
 * questions; a client that does not still gets the same guards, because every
 * one of them is enforced in code as well as stated here.
 */
import { CREATOR_REPLY_TEMPLATES, MCP_KEY_SCOPE_DESCRIPTIONS } from '@wizard-ads/shared';
import { ENTITY_LEVELS, LEVELS } from './catalog.js';
import { ALL_METRICS, DERIVED_METRICS } from './metrics.js';
import { FILTER_OPERATORS } from './sql.js';

export function instructionsDocument(orgSlug: string, profileCount: number): string {
  const levels = ENTITY_LEVELS.map((level) => `- \`${level}\` — ${LEVELS[level].description}`).join('\n');
  const ratios = Object.entries(DERIVED_METRICS)
    .map(([name, descriptor]) => `- \`${name}\` = ${descriptor.description}`)
    .join('\n');

  return `# Arcana MCP — read-only

You are connected to **${orgSlug}** with a read-only key covering ${profileCount} profile${
    profileCount === 1 ? '' : 's'
  }.
Every call you make is written to the audit log with its parameters. Nothing you can call
changes an Amazon account or Arcana product data. The production catalog contains
analytical reads only. Creator Connections writes need a separate \`creator:write\` key; this
key cannot call them.

## The pipeline

    FETCH    list_profiles -> get_entity_data          what the numbers are
    REFINE   query / group_by                          slice them
    EXPORT   download_data                             take them away as CSV
    EXPLAIN  get_flags / get_pacing / get_recommendations

Start with \`list_profiles\`. Never guess a profile id. \`profile_id\` is required on every
profile-scoped tool and is applied as a predicate on the fact scan, so a result set contains
that profile and nothing else.

## Entity levels

${levels}

## Metrics

Base metrics are summed: ${['impressions', 'clicks', 'spend', 'sales', 'orders', 'units'].join(', ')}.
Ratios are **recomputed from summed bases**, never averaged:

${ratios}

Every metric name usable in \`metrics\`, \`sort\` or a filter: ${ALL_METRICS.join(', ')}.

Do not ask for a GROUP BY in \`query\`. \`query\` returns daily rows; \`group_by\` aggregates and
recalculates the ratios correctly. An ACOS that is the mean of ACOSes is wrong in a way that
looks right.

## Comparisons

Pass \`compare: true\` to \`get_entity_data\` and every metric gains three columns:
\`<metric>_comparison\`, \`<metric>_delta_absolute\`, \`<metric>_delta_percent\`. The comparison
window defaults to the immediately preceding period of the same length.

**\`delta_percent\` is a true percent everywhere.** \`+12.5\` means twelve and a half percent up.
There is one convention in this server.

## Filters

    {"key": "SPEND", "operator": ">", "values": ["50"]}

Keys are uppercase column names. Conditions are ANDed; use \`IN\` for alternatives. Operators:
${FILTER_OPERATORS.join(', ')}. \`LIKE\` is case-insensitive, because match types and states are
spelled differently on different Amazon surfaces and a capital letter should not cost you a
result set.

Three keys are not columns:

- \`ACOS_TO_TARGET\` — ACOS divided by the profile's target ACOS, so \`>= 1.1\` means "10% above
  target" on any profile in any currency.
- \`DELTA_PERCENT\` / \`DELTA_ABSOLUTE\` — take a \`metric\` and filter on its movement. Needs a
  comparison window.

## What the numbers mean

- **Absence is not zero.** Amazon omits zero-impression rows from reports, so a target missing
  from a result got no impressions *or* was never reported. Read \`get_sync_status\` before
  concluding anything from an absence.
- **Same-day data is provisional.** Sales restate for 14 or more days. Every response carries
  the latest fact date and whether it is still attributing; anchor conclusions on completed days.
- **Archived is included.** Rows are read from the fact tables, so spend on an archived campaign
  still appears, with its state on the row. A period total that silently excluded it would not
  reconcile against Amazon.
- **The product level attributes through single-ASIN ad groups only.** Ad groups advertising
  more than one ASIN cannot be split without inventing a number, so they are excluded and the
  excluded spend is reported on every product response. Read it before quoting an ASIN total.

## Per-profile context

Read \`wizardads://profiles/{profile_id}\` for a profile's settings, the doctrine document's
shape, its entity counts, its freshness, and the changes somebody made outside Arcana
recently. It is the context you need before proposing anything, and it arrives with the data
rather than as a separate step you have to remember.
`;
}

/**
 * The bootstrap document for a `creator:write` key: what each of the seven tools
 * takes, in the control runner's shapes, and what each refuses. Written for the
 * author of the `amazon-creator-connections` skill.
 */
export function creatorWriteInstructionsDocument(orgSlug: string): string {
  const templates = CREATOR_REPLY_TEMPLATES.map((template) => `- \`${template.key}\` — ${template.name}`).join('\n');
  return `# Arcana MCP — creator:write

You are connected to **${orgSlug}** with a \`creator:write\` key. ${MCP_KEY_SCOPE_DESCRIPTIONS['creator:write']}
It can call the seven tools below and read this document; it cannot call an analytics tool, and an
analytics (read) key cannot call these. Every call writes one audit row holding a digest of the
arguments and their size, never the arguments.

Creator status written here is **not** an Amazon write. Nothing here sends a message, places an
order or changes an Amazon account. A reply draft is text an operator sends by hand.

## Fingerprints only

Send the HMAC fingerprints \`creator_control.py\` computes (\`record_fingerprints\`), never the values.
Any argument that carries an email address, a phone number, a street address or a link, or a key
named like one (\`email\`, \`phone\`, \`address\`, \`full_name\`, \`storefront_url\`, ...), is refused
and nothing is written. Evidence references are opaque references (\`ev:...\`), not links.

## The tools

Each takes the runner's own JSON, snake_case, and is idempotent: a replay, or a row the file import
(\`creators:import\`) already wrote, reports \`unchanged\`. Counts come back as
\`{read, inserted, updated, unchanged, skipped}\` per kind of row, where
read = inserted + updated + unchanged + skipped and \`skipped\` is rows left untouched on purpose.

1. \`creators.register_record\` — \`{record, resolution}\`. \`record\` is one Creator Registry row as
   \`issue_record_id\` created it and later commands changed it (\`creator_record_id\`, \`brand\`,
   \`campaign_id\`, \`thread_key\`, \`storefront_key\`, \`full_name_fp\`, \`email_fp\`, \`phone_fp\`,
   \`address_fp\`, \`record_state\`, \`lock_state\`, \`escalation_reason\`, \`version\`, \`created_at\`,
   \`last_verified_at\`, and the optional \`mcf_reservation\`, \`sample_history\` and
   \`mcf_reservation_history\`). \`resolution\` is the \`resolve_record\` result \`register\` acted on:
   \`RESOLVED\` (with \`match_method\` storefront, thread or contacts), \`NEW\` (with the fingerprints the
   record was issued with) or \`CONFLICT\` (with \`matches\`, which must include this record, locked in
   Conflict). \`HOLD\` registers nothing. Register every record a conflict locked. A row whose \`version\`
   is older than the one held is refused as \`older_than_held\` and nothing of it is written.
2. \`creators.record_score\` — \`{creator_record_id, scored_on, current_status, tracker_score, result}\`.
   \`result\` is the \`score\` command's output (\`score_record\`: \`score\`, the ten \`checks\`, \`missing\`).
   \`current_status\` is the tracker's Status label; \`tracker_score\` is the Total Qualification Score
   typed on the tracker, or null when blank. A score dated before the one held changes nothing.
3. \`creators.append_action\` — \`{entries: [...]}\`, 1 to 200 Creator Action Log entries the skill
   recorded: \`{event_key, creator_record_id, action, occurred_at, reservation_id?, asin?, reason_code?,
   evidence_reference?}\` where \`action\` is one of \`message_sent_by_hand\`, \`status_moved\`,
   \`content_verified\`, \`escalated\`, \`preflight_recorded\`. Reservation, confirmation and cancellation
   history comes with the registry row instead. Reusing an \`event_key\` for other content is refused.
4. \`creators.submit_draft\` — \`{creator_record_id, thread_key, template_key, draft_date, body}\`. Returns
   \`draft_id\`. \`body\` is the text rendered from one approved template, at most 4000 characters, with
   the name placeholders left exactly as the template writes them: \`{first name}\` in every template,
   and \`{recipient name}\` in \`recipient_mismatch_clarification\`. Arcana stores no names; the operator
   fills them in when sending by hand. A body without them is refused. A new
   text for a thread withdraws that thread's open draft; a thread whose draft is already approved is
   refused until an owner or admin marks it sent by hand or withdraws it. A record locked in Conflict
   takes no draft. Templates:

${templates}

5. \`creators.queue_snapshot\` — the \`queue\` command's whole output file: \`{run_date, items, counts}\`,
   every item a \`queue_item\` result for that \`run_date\`. One invalid item refuses the snapshot. A
   newer snapshot for the same day replaces that day, as the import does. A snapshot for a day before the
   newest day held is refused.
6. \`creators.sweep_checkpoint\` — the proposed sweep checkpoint: \`{schema_version: 1, run_id, run_date,
   brand, started_at, completed_at, evidence_reference, counts, threads}\` with the nine counts and one
   \`{thread_key, creator_record_id, sender_role, amazon_timestamp, body_hash, outcome, reason}\` per
   thread. Arcana computes whether the sweep reconciled; the file cannot claim it.
7. \`creators.preflight_result\` — one \`creator_control.py\` \`preflight\` or \`preflight-switch\` result:
   \`{command, run_id, started_at, completed_at, result, inventory, ...}\`. For \`preflight\`, \`result\` is the
   \`mcf_preflight\` output, \`preview\` the getFulfillmentPreview read (or null) and \`reads\` up to eight
   \`{check, read_at, evidence_reference}\`; Arcana files each error code under one of the eight checks and
   refuses a code it does not know. For \`preflight-switch\`, \`result\` is the \`product_switch_preflight\`
   output for one alternate, with \`original_unavailable_reason\` and \`original_blocker_evidence_reference\`.
   \`inventory\` is the \`product_catalog\` entry the runner checked. Never the recipient block:
   \`recipient_binding\` is its fingerprint. Returns the lane's \`derived_order_key\`. Arcana places no
   order and changes no lane or lock. Reusing a \`run_id\` for another result is refused.

## Errors

\`invalid_argument\` names the failing paths and codes, never the values. \`not_found\` means the record
is not registered for this organisation: register it first. \`forbidden\` means the key was revoked,
expired, or its issuer is no longer an owner or admin here.
`;
}
