#!/usr/bin/env bash
# Install or refresh wizard-ads-mcf.service on the Evo (WP-338f). Run it from a
# clean checkout of the release revision, after the general worker's
# worker-current points at that release (runtime first):
#
#   bash docs/deploy/install-mcf-evo-systemd.sh --revision <full-git-object-id> [--dry-run]
#
# It checks the release, the credentials and that a dynamic user can read the
# release, backs up the current unit, drop-in and configuration, installs the unit
# from this checkout, writes the recipient-key drop-in from the credential store,
# writes a flags-off configuration only if none exists, and enables and (re)starts
# the unit. It never changes the database, a credential or another unit. Rerun it
# after adding or removing a recipient key file. --dry-run installs and changes
# nothing: it runs every check (which takes the deployment lock, uses a temporary
# directory and runs a transient probe unit) and prints each change instead of
# making it.
set -euo pipefail

expected_revision=
dry_run=false
while (($# > 0)); do
  case "$1" in
    --revision)
      expected_revision="${2:-}"
      shift 2 || { echo "usage: $0 --revision <full-git-object-id> [--dry-run]" >&2; exit 2; }
      ;;
    --dry-run)
      dry_run=true
      shift
      ;;
    *)
      echo "usage: $0 --revision <full-git-object-id> [--dry-run]" >&2
      exit 2
      ;;
  esac
done
if [[ ! "$expected_revision" =~ ^[0-9a-f]{40}$ ]]; then
  echo "refusing: --revision must be a full lowercase Git object id" >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=docs/deploy/mcf-evo-systemd-lib.sh
source "$script_dir/mcf-evo-systemd-lib.sh"
mcf_dry_run="$dry_run"
work_dir=
cleanup() {
  case "$work_dir" in
    */wizard-ads-mcf-install.*) find "$work_dir" -depth -delete 2>/dev/null || true ;;
  esac
}
trap cleanup EXIT

for command in cmp find flock git python3 sha256sum sudo systemctl systemd-analyze systemd-run; do
  command -v "$command" >/dev/null || { echo "refusing: required command is unavailable: $command" >&2; exit 1; }
done
if ! mcf_assert_checkout "$expected_revision" "$script_dir"; then
  echo "refusing: run this from a clean checkout whose HEAD is $expected_revision" >&2
  exit 1
fi
mcf_lock || exit 1
[[ "$dry_run" == true ]] && echo "dry run: nothing is installed or changed; the checks take a lock, use a temporary directory and run a transient probe unit"
echo "systemd: $(systemctl --version | head -n 1)"

# 1. The release the general worker already runs.
mcf_assert_release "$expected_revision" "$script_dir" || exit 1
release="$(mcf_release_dir "$expected_revision")"
echo "release: worker-releases/$expected_revision verifies and carries the mcf mode"

# 2. The unit in this checkout parses cleanly on this host: a failure or any
# warning about the unit refuses (systemd-analyze exits 0 on an ignored line).
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/wizard-ads-mcf-install.XXXXXX")"
install -m 0644 "$script_dir/wizard-ads-mcf.service" "$work_dir/$mcf_service"
if ! analysis="$(systemd-analyze verify "$work_dir/$mcf_service" 2>&1)" \
  || grep -qF -- "$mcf_service" <<<"$analysis"; then
  printf '%s\n' "$analysis" >&2
  echo "refusing: systemd-analyze reports a problem with $mcf_service" >&2
  exit 1
fi

# 3. Credentials: the static three, every recipient key file, and isolation.
mcf_assert_static_credentials || exit 1
key_ids="$(mcf_recipient_key_ids)" || exit 1
mapfile -t recipient_ids < <(printf '%s' "$key_ids" | sed '/^$/d')
mcf_assert_key_isolation || exit 1
echo "credentials: database and SP-API LWA present; recipient keys in the store: ${#recipient_ids[@]}"

# 4. The configuration: kept if present (and valid), else a flags-off default.
config_path="$(mcf_path "$mcf_config")"
if sudo test -e "$config_path"; then
  config_summary="$(mcf_check_config "$release/credential_runtime.py" "$config_path")" || exit 1
  config_state=kept
else
  mcf_default_config >"$work_dir/mcf.json"
  config_summary="$(mcf_check_config "$release/credential_runtime.py" "$work_dir/mcf.json")" || exit 1
  config_state=new
fi
if [[ "$(mcf_json_field "$config_summary" preview)" == true || "$(mcf_json_field "$config_summary" dispatch)" == true ]] \
  && ((${#recipient_ids[@]} == 0)); then
  echo "refusing: a flag is on in $mcf_config but the credential store holds no recipient key" >&2
  exit 1
fi
echo "configuration ($config_state): $config_summary"

# 5. A dynamic user can read the release (and the configuration, if it exists).
probe_paths=("$release/")
if [[ "$config_state" == kept ]]; then
  probe_paths+=("$config_path")
fi
mcf_assert_dynamic_user_can_read "${probe_paths[@]}" || exit 1
echo "dynamic user: reads the release"

# 6. Back up, then change.
backup="$(mcf_path "$mcf_backup_root")/$(date -u +%Y%m%dT%H%M%SZ)-$expected_revision"
if sudo test -e "$backup" || sudo test -e "$backup.rolled-back"; then
  echo "refusing: a backup with this timestamp already exists; run the install again in a second" >&2
  exit 1
fi
mcf_dropin_text "${recipient_ids[@]}" >"$work_dir/recipient-keys.conf"
mcf_backup "$backup" || exit 1
mcf_change install -d -m 0755 -o "$mcf_owner" -g "$mcf_group" "$(mcf_path "$mcf_config_dir")"
if [[ "$config_state" == new ]]; then
  mcf_place "$work_dir/mcf.json" "$config_path" 0644
fi
mcf_change install -d -m 0755 -o "$mcf_owner" -g "$mcf_group" "$(mcf_path "$mcf_dropin_dir")"
mcf_place "$work_dir/recipient-keys.conf" "$(mcf_path "$mcf_dropin")" 0644
mcf_place "$script_dir/wizard-ads-mcf.service" "$(mcf_path "$mcf_unit")" 0644
mcf_change systemctl daemon-reload
if [[ "$config_state" == new && "$dry_run" != true ]]; then
  mcf_assert_dynamic_user_can_read "$config_path" || exit 1
fi
mcf_change systemctl enable "$mcf_service"
if [[ "$(systemctl is-active "$mcf_service" 2>/dev/null || true)" == active ]]; then
  # A stop waits up to TimeoutStopSec for a create already sent to be recorded.
  mcf_change systemctl restart "$mcf_service"
else
  mcf_change systemctl start "$mcf_service"
fi

if [[ "$dry_run" == true ]]; then
  echo "dry run complete: nothing was installed or changed (a transient probe unit ran)"
  exit 0
fi
if [[ "$(systemctl is-active "$mcf_service" 2>/dev/null || true)" != active ]]; then
  echo "$mcf_service did not become active; read: sudo journalctl -u $mcf_service -n 50 -o cat" >&2
  echo "backup of the previous state: ${backup#"$mcf_root"}" >&2
  exit 1
fi
echo "installed $mcf_service at revision $expected_revision (backup ${backup#"$mcf_root"})"
echo "next: bash docs/deploy/verify-mcf-evo-systemd.sh --revision $expected_revision"
