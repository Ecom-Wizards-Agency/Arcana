#!/usr/bin/env bash
# Return wizard-ads-mcf.service to an earlier state (WP-338f):
#
#   bash docs/deploy/rollback-mcf-evo-systemd.sh [--dry-run]
#   bash docs/deploy/rollback-mcf-evo-systemd.sh --remove [--dry-run]
#
# Without --remove it steps back one install: it stops the unit (the stop waits up
# to TimeoutStopSec for a create already sent to be recorded), disables it, and
# restores the unit file and configuration from the newest install backup. The
# recipient-key drop-in is rebuilt from the key files in the credential store
# rather than copied back, so a key destroyed since that install is never named.
# What the restore replaces is kept in that backup directory as *.replaced, never
# deleted. If the unit was running before that install, it is enabled and started
# again.
#
# --remove takes the unit out in one step: stop, disable, and move the unit, the
# drop-in and the configuration into /etc/wizard-ads-mcf/backups/<UTC time>-removed/.
# Use it before rolling the general worker's release back past WP-338f, whose
# runtime has no mcf mode.
#
# Neither mode touches the database, a credential file or another unit. In-flight
# sends stay observed by mcf.observe in the general worker and settle when the unit
# runs again; custody expires through the general worker's housekeeping or pg_cron.
set -euo pipefail

dry_run=false
remove=false
while (($# > 0)); do
  case "$1" in
    --dry-run) dry_run=true; shift ;;
    --remove) remove=true; shift ;;
    *) echo "usage: $0 [--remove] [--dry-run]" >&2; exit 2 ;;
  esac
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=docs/deploy/mcf-evo-systemd-lib.sh
source "$script_dir/mcf-evo-systemd-lib.sh"
mcf_dry_run="$dry_run"
work_dir=
cleanup() {
  case "$work_dir" in
    */wizard-ads-mcf-rollback.*) find "$work_dir" -depth -delete 2>/dev/null || true ;;
  esac
}
trap cleanup EXIT

for command in find flock python3 sudo systemctl; do
  command -v "$command" >/dev/null || { echo "refusing: required command is unavailable: $command" >&2; exit 1; }
done
mcf_lock || exit 1
[[ "$dry_run" == true ]] && echo "dry run: nothing is restored, moved or restarted; the checks take a lock"

stop_and_disable() {
  if [[ "$(systemctl is-active "$mcf_service" 2>/dev/null || true)" == active ]]; then
    echo "stopping $mcf_service (waits for any create already sent to be recorded)"
    mcf_change systemctl stop "$mcf_service"
  fi
  if [[ "$(systemctl is-enabled "$mcf_service" 2>/dev/null || true)" == enabled ]]; then
    mcf_change systemctl disable "$mcf_service"
  fi
  if [[ "$dry_run" != true ]]; then
    [[ "$(systemctl is-active "$mcf_service" 2>/dev/null || true)" != active ]] \
      || { echo "refusing to continue: $mcf_service is still active" >&2; return 1; }
    [[ "$(systemctl is-enabled "$mcf_service" 2>/dev/null || true)" != enabled ]] \
      || { echo "refusing to continue: $mcf_service is still enabled" >&2; return 1; }
  fi
}

if [[ "$remove" == true ]]; then
  removed="$(mcf_path "$mcf_backup_root")/$(date -u +%Y%m%dT%H%M%SZ)-removed"
  if sudo test -e "$removed"; then
    echo "refusing: $removed already exists; run the removal again in a second" >&2
    exit 1
  fi
  prior_state="$(mcf_unit_state)"
  mcf_change install -d -m 0700 -o "$mcf_owner" -g "$mcf_group" "$(mcf_path "$mcf_backup_root")" "$removed"
  if [[ "$dry_run" == true ]]; then
    printf 'dry-run: would record the unit state (%s) in %s/state\n' "${prior_state//$'\n'/ }" "$removed"
  else
    printf '%s\n' "$prior_state" | sudo tee "$removed/state" >/dev/null
  fi
  stop_and_disable || exit 1
  for part in unit dropin config; do
    case "$part" in
      unit) target="$(mcf_path "$mcf_unit")" ;;
      dropin) target="$(mcf_path "$mcf_dropin")" ;;
      config) target="$(mcf_path "$mcf_config")" ;;
    esac
    if sudo test -f "$target"; then
      mcf_change mv -T -- "$target" "$removed/$part"
    else
      mcf_change touch -- "$removed/$part.absent"
    fi
  done
  mcf_change systemctl daemon-reload
  if [[ "$dry_run" == true ]]; then
    echo "dry run complete: no file, unit or service was changed"
    exit 0
  fi
  echo "removed $mcf_service; its unit, drop-in and configuration are in ${removed#"$mcf_root"}"
  echo "credential files in $mcf_credstore and the database are unchanged"
  exit 0
fi

name="$(mcf_latest_backup)"
if [[ -z "$name" ]]; then
  echo "refusing: no install backup to roll back to under $mcf_backup_root" >&2
  exit 1
fi
backup="$(mcf_path "$mcf_backup_root")/$name"
if sudo find "$backup" -mindepth 1 -maxdepth 1 -name '*.replaced' -print -quit | grep -q .; then
  echo "refusing: an earlier rollback of backup $name stopped partway; its *.replaced files hold what it replaced. Restore by hand, or take the unit out with --remove" >&2
  exit 1
fi
for part in unit dropin config; do
  present=0
  sudo test -f "$backup/$part" && present=$((present + 1))
  sudo test -f "$backup/$part.absent" && present=$((present + 1))
  if ((present != 1)); then
    echo "refusing: backup $name does not record the $part exactly once" >&2
    exit 1
  fi
done
prior_state="$(sudo cat "$backup/state" 2>/dev/null || true)"
state_pattern=$'^enabled=[a-z-]+\nactive=[a-z-]+$'
if [[ ! "$prior_state" =~ $state_pattern ]]; then
  echo "refusing: backup $name does not record the unit's prior state" >&2
  exit 1
fi

# Everything the restore needs is checked before anything changes: the drop-in
# is rebuilt from the key files in the store, and a configuration to restore
# must pass the current release's runtime and have a key for any flag it sets.
key_ids="$(mcf_recipient_key_ids)" || exit 1
mapfile -t recipient_ids < <(printf '%s' "$key_ids" | sed '/^$/d')
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/wizard-ads-mcf-rollback.XXXXXX")"
mcf_dropin_text "${recipient_ids[@]}" >"$work_dir/recipient-keys.conf"
if sudo test -f "$backup/config"; then
  sudo cat "$backup/config" >"$work_dir/mcf.json"
  config_summary="$(mcf_check_config "$(mcf_path "$mcf_runtime_root/worker-current")/credential_runtime.py" \
    "$work_dir/mcf.json")" || exit 1
  if [[ "$(mcf_json_field "$config_summary" preview)" == true || "$(mcf_json_field "$config_summary" dispatch)" == true ]] \
    && ((${#recipient_ids[@]} == 0)); then
    echo "refusing: the configuration in backup $name turns a flag on but the credential store holds no recipient key" >&2
    exit 1
  fi
fi
echo "rolling back to backup $name (prior state: ${prior_state//$'\n'/ }; recipient keys in the store: ${#recipient_ids[@]})"

# 1. Stop and disable; prove it.
stop_and_disable || exit 1

# 2. Restore each file; what it replaces moves into the backup as *.replaced.
restore() {
  local part="$1" target="$2" source="$3"
  if sudo test -f "$target"; then
    mcf_change mv -T -- "$target" "$backup/$part.replaced" || return 1
  fi
  if [[ -n "$source" ]]; then
    mcf_change install -m 0644 -o "$mcf_owner" -g "$mcf_group" -- "$source" "$target" || return 1
  fi
}
restore unit "$(mcf_path "$mcf_unit")" "$(sudo test -f "$backup/unit" && printf '%s' "$backup/unit")" || exit 1
restore dropin "$(mcf_path "$mcf_dropin")" "$(sudo test -f "$backup/dropin" && printf '%s' "$work_dir/recipient-keys.conf")" \
  || exit 1
restore config "$(mcf_path "$mcf_config")" "$(sudo test -f "$backup/config" && printf '%s' "$backup/config")" || exit 1
mcf_change systemctl daemon-reload

# 3. Return the unit to its prior state.
if [[ "$prior_state" == *enabled=enabled* ]]; then
  mcf_change systemctl enable "$mcf_service"
fi
if [[ "$prior_state" == *active=active* ]]; then
  mcf_change systemctl start "$mcf_service" \
    || echo "$mcf_service did not start; the restore itself is complete" >&2
fi
mcf_change mv -T -- "$backup" "$backup.rolled-back"

if [[ "$dry_run" == true ]]; then
  echo "dry run complete: no file, unit or service was changed"
  exit 0
fi
if [[ "$prior_state" == *active=active* \
  && "$(systemctl is-active "$mcf_service" 2>/dev/null || true)" != active ]]; then
  echo "$mcf_service did not become active after the rollback; read: sudo journalctl -u $mcf_service -n 50 -o cat" >&2
  exit 1
fi
echo "rolled $mcf_service back to backup $name"
echo "credential files in $mcf_credstore and the database are unchanged"
