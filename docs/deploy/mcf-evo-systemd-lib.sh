#!/usr/bin/env bash
# Shared, fail-closed helpers for install-, verify- and rollback-mcf-evo-systemd.sh
# (WP-338f). Sourced, never run. The commands run on the Evo from a clean checkout
# of the release revision; they never read a credential value except the heartbeat
# probe, which decrypts the database credential inside its own transient dynamic-user
# unit so the value never reaches the operator's shell.
#
# MCF_EVO_ROOT is a test hook for test-evo-mcf-deployment.sh: a fixture directory
# prefixed to every host path. It is empty on the Evo.

mcf_root="${MCF_EVO_ROOT:-}"
if [[ -n "$mcf_root" && ( "$mcf_root" != /* || ! -d "$mcf_root" ) ]]; then
  echo "refusing: MCF_EVO_ROOT must be an existing absolute fixture directory" >&2
  exit 2
fi
mcf_service=wizard-ads-mcf.service
mcf_runtime_root=/usr/local/lib/wizard-ads-runtime
mcf_unit=/etc/systemd/system/wizard-ads-mcf.service
mcf_dropin_dir=/etc/systemd/system/wizard-ads-mcf.service.d
mcf_dropin=$mcf_dropin_dir/recipient-keys.conf
mcf_config_dir=/etc/wizard-ads-mcf
mcf_config=$mcf_config_dir/mcf.json
mcf_backup_root=$mcf_config_dir/backups
mcf_credstore=/etc/credstore.encrypted
mcf_lock_file=/run/lock/wizard-ads-mcf-deployment.lock
mcf_node=/usr/local/bin/node
mcf_static_credentials=(database-url spapi-lwa-client-id spapi-lwa-client-secret-value)
mcf_dry_run=false
mcf_lock_fd=
mcf_owner=root
mcf_group=root
if [[ -n "$mcf_root" ]]; then
  mcf_owner="$(id -un)"
  mcf_group="$(id -gn)"
fi

mcf_path() {
  printf '%s%s' "$mcf_root" "$1"
}

# Every change goes through here: printed and skipped with --dry-run.
mcf_change() {
  if [[ "$mcf_dry_run" == true ]]; then
    printf 'dry-run: would run:'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  sudo "$@"
}

mcf_lock() {
  local lock
  lock="$(mcf_path "$mcf_lock_file")"
  if [[ -L "$lock" ]]; then
    echo "refusing: the deployment lock path is a symlink" >&2
    return 1
  fi
  exec {mcf_lock_fd}>>"$lock" || return 1
  if ! flock --nonblock "$mcf_lock_fd"; then
    echo "refusing: another MCF deployment command is running" >&2
    return 1
  fi
}

# The script must run from a clean checkout whose HEAD is the release revision.
mcf_assert_checkout() {
  local revision="$1" script_dir="$2" repo_root
  repo_root="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null)" || return 1
  [[ "$script_dir" == "$repo_root/docs/deploy" ]] || return 1
  [[ -z "$(git -C "$repo_root" status --porcelain --untracked-files=normal)" ]] || return 1
  [[ "$(git -C "$repo_root" rev-parse HEAD)" == "$revision" ]]
}

mcf_release_dir() {
  mcf_path "$mcf_runtime_root/worker-releases/$1"
}

# The general worker already runs this release (runtime first), its files verify,
# and its runtime and entry are this checkout's.
mcf_assert_release() {
  local revision="$1" script_dir="$2" release link
  link="$(readlink "$(mcf_path "$mcf_runtime_root/worker-current")" 2>/dev/null || true)"
  if [[ "$link" != "worker-releases/$revision" ]]; then
    echo "refusing: worker-current does not point at worker-releases/$revision; upgrade the general worker to this release first" >&2
    return 1
  fi
  release="$(mcf_release_dir "$revision")"
  if [[ ! -d "$release" || -L "$release" || "$(cat "$release/REVISION" 2>/dev/null || true)" != "$revision" ]]; then
    echo "refusing: the release directory does not carry revision $revision" >&2
    return 1
  fi
  if ! (cd "$release" && sha256sum --quiet --strict -c ARTIFACT_SHA256 >/dev/null 2>&1) \
    || ! (cd "$release" && find . -type l -printf '%P\t%l\n' | LC_ALL=C sort | cmp -s - ARTIFACT_LINKS); then
    echo "refusing: the release checksums or link manifest do not verify" >&2
    return 1
  fi
  if find "$release" -xdev \( ! -user "$mcf_owner" -o ! -group "$mcf_group" \) -print -quit | grep -q . \
    || find "$release" \( -type f -o -type d \) -perm /022 -print -quit | grep -q .; then
    echo "refusing: the release is not owned by root or is writable by others" >&2
    return 1
  fi
  if ! cmp -s "$release/credential_runtime.py" "$script_dir/wizard-ads-credential-runtime.py" \
    || [[ ! -f "$release/app/src/mcf-main.ts" ]]; then
    echo "refusing: the release's runtime or MCF entry differs from this checkout" >&2
    return 1
  fi
}

# A transient dynamic-user unit, hardened like wizard-ads-mcf.service, must read
# every release file and traverse every release directory. If it cannot, the
# documented fallback is a static user (always-on-worker.md).
mcf_assert_dynamic_user_can_read() {
  local output
  if ! output="$(sudo systemd-run --quiet --wait --pipe --collect \
    --property=DynamicUser=yes --property=ProtectSystem=strict --property=ProtectHome=yes \
    --property=PrivateTmp=yes --property=ProtectProc=invisible --property=ProcSubset=pid \
    --property=NoNewPrivileges=yes \
    /usr/bin/find "$@" \( ! -readable -o \( -type d ! -executable \) \) -print -quit 2>&1)" \
    || [[ -n "$output" ]]; then
    echo "refusing: a dynamic user cannot read the release or the MCF configuration; see 'Static user fallback' in docs/deploy/always-on-worker.md" >&2
    return 1
  fi
}

mcf_assert_credential_file() {
  local path="$1" metadata
  if ! sudo test -f "$path" || sudo test -L "$path"; then
    echo "refusing: encrypted credential is missing or not a regular file: $(basename "$path")" >&2
    return 1
  fi
  metadata="$(sudo stat -c '%a:%U:%G' "$path")"
  case "$metadata" in
    "400:$mcf_owner:$mcf_group" | "600:$mcf_owner:$mcf_group") ;;
    *)
      echo "refusing: encrypted credential is not root-owned with mode 0400 or 0600: $(basename "$path")" >&2
      return 1
      ;;
  esac
}

mcf_assert_static_credentials() {
  local name
  for name in "${mcf_static_credentials[@]}"; do
    mcf_assert_credential_file "$(mcf_path "$mcf_credstore")/wizard-ads-$name.cred" || return 1
  done
}

# Prints the credential id of every recipient key in the store, one per line,
# sorted. Refuses a malformed file name or an unsafe file.
mcf_recipient_key_ids() {
  local store name listing
  store="$(mcf_path "$mcf_credstore")"
  listing="$(sudo find "$store" -mindepth 1 -maxdepth 1 -name 'wizard-ads-mcf-recipient-*' -printf '%f\n' | LC_ALL=C sort)" \
    || return 1
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    if [[ ! "$name" =~ ^wizard-ads-mcf-recipient-([0-9a-f]{8})\.cred$ ]]; then
      echo "refusing: a recipient key file name is not wizard-ads-mcf-recipient-<keyId8>.cred" >&2
      return 1
    fi
    mcf_assert_credential_file "$store/$name" || return 1
    printf 'mcf-recipient-%s\n' "${BASH_REMATCH[1]}"
  done <<<"$listing"
}

# The drop-in that loads the recipient keys; key ids never enter a tracked file.
mcf_dropin_text() {
  local id
  printf '%s\n' \
    '# Written by install-mcf-evo-systemd.sh from the credential store. Do not edit:' \
    '# add or remove a wizard-ads-mcf-recipient-<keyId8>.cred file and run the install again.' \
    '[Service]'
  for id in "$@"; do
    printf 'LoadCredentialEncrypted=%s:%s/wizard-ads-%s.cred\n' "$id" "$mcf_credstore" "$id"
  done
}

# No unit but the MCF unit and its drop-in may name a recipient key, and no unit
# may import one through an ImportCredential= glob (systemd 254 and later), in
# any of the three unit directories.
mcf_unit_dirs=(/etc/systemd/system /run/systemd/system /usr/lib/systemd/system)
mcf_assert_key_isolation() {
  local dir dirs=() hits globs
  for dir in "${mcf_unit_dirs[@]}"; do
    if sudo test -d "$(mcf_path "$dir")"; then
      dirs+=("$(mcf_path "$dir")")
    fi
  done
  ((${#dirs[@]} > 0)) || { echo "refusing: no systemd unit directory is readable" >&2; return 1; }
  hits="$(sudo grep -rlF -- 'mcf-recipient' "${dirs[@]}" 2>/dev/null \
    | grep -v -x -F -e "$(mcf_path "$mcf_unit")" -e "$(mcf_path "$mcf_dropin")" || true)"
  if [[ -n "$hits" ]]; then
    echo "refusing: a unit other than $mcf_service names a recipient key:" >&2
    printf '  %s\n' "${hits//$mcf_root/}" >&2
    return 1
  fi
  # A glob matches when it equals a name or is a prefix ending in "*"; only a
  # trailing "*" is allowed, and ":rename" does not change what is read.
  globs="$(sudo grep -rhE -- '^[[:space:]]*ImportCredential[[:space:]]*=' "${dirs[@]}" 2>/dev/null || true)"
  if ! python3 -c '
import sys
names = ("wizard-ads-mcf-recipient-00000000.cred", "wizard-ads-mcf-recipient-00000000",
         "mcf-recipient-00000000")
for line in sys.stdin.read().splitlines():
    if "=" not in line:
        continue
    glob = line.split("=", 1)[1].strip().split(":", 1)[0].strip()
    if not glob:
        continue
    if any(name == glob or (glob.endswith("*") and name.startswith(glob[:-1])) for name in names):
        sys.exit(f"refusing: a unit imports credentials with ImportCredential={glob}, which matches a recipient key file")
' <<<"$globs"; then
    return 1
  fi
  if sudo grep -qF -- 'mcf-alert-webhook' "$(mcf_path "$mcf_unit")" 2>/dev/null; then
    echo "refusing: $mcf_service loads the general worker's alert webhook" >&2
    return 1
  fi
}

# Validates a configuration with the release's own runtime code and prints
# {"preview":bool,"dispatch":bool,"scopeEntries":n,"workerId":"..."}.
mcf_check_config() {
  local runtime="$1" config="$2"
  python3 -B - "$runtime" "$config" <<'PY'
import importlib.util, json, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("credential_runtime", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.MCF_CONFIG = Path(sys.argv[2])
try:
    config = module.mcf_config()
    preview, dispatch, scope = module.mcf_settings(config)
except RuntimeError as exc:
    sys.exit(f"refusing: {exc}")
print(json.dumps({"preview": preview, "dispatch": dispatch, "scopeEntries": len(scope),
                  "workerId": config.get("WORKER_ID", "wizard-ads-mcf")}, separators=(",", ":")))
PY
}

mcf_json_field() {
  python3 -c 'import json,sys; v=json.loads(sys.argv[1])[sys.argv[2]]; print(json.dumps(v) if isinstance(v,bool) else v)' "$1" "$2"
}

mcf_default_config() {
  printf '%s\n' '{' \
    '  "OPENSPELL_MCF_PREVIEW_ENABLED": "0",' \
    '  "OPENSPELL_MCF_DISPATCH_ENABLED": "0"' \
    '}'
}

mcf_unit_state() {
  local enabled active
  enabled="$(systemctl is-enabled "$mcf_service" 2>/dev/null || true)"
  active="$(systemctl is-active "$mcf_service" 2>/dev/null || true)"
  printf 'enabled=%s\nactive=%s\n' "${enabled:-absent}" "${active:-inactive}"
}

# The newest backup that has not been rolled back, or nothing.
mcf_latest_backup() {
  local root
  root="$(mcf_path "$mcf_backup_root")"
  sudo test -d "$root" || return 0
  sudo find "$root" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended \
    -regex '.*/[0-9]{8}T[0-9]{6}Z-[0-9a-f]{40}' -printf '%f\n' | LC_ALL=C sort | tail -n 1
}

# Keeps what the unit, its drop-in and its configuration were before a change.
mcf_backup() {
  local backup="$1" name source
  mcf_change install -d -m 0700 -o "$mcf_owner" -g "$mcf_group" "$(mcf_path "$mcf_backup_root")" "$backup" || return 1
  for name in unit dropin config; do
    case "$name" in
      unit) source="$(mcf_path "$mcf_unit")" ;;
      dropin) source="$(mcf_path "$mcf_dropin")" ;;
      config) source="$(mcf_path "$mcf_config")" ;;
    esac
    if sudo test -f "$source"; then
      mcf_change cp -p -- "$source" "$backup/$name" || return 1
    else
      mcf_change touch -- "$backup/$name.absent" || return 1
    fi
  done
  if [[ "$mcf_dry_run" == true ]]; then
    printf 'dry-run: would record the unit state (%s) in %s/state\n' "$(mcf_unit_state | tr '\n' ' ')" "$backup"
  else
    mcf_unit_state | sudo tee "$backup/state" >/dev/null
  fi
}

# Atomically places a file: a staged copy beside the target, then a rename.
mcf_place() {
  local source="$1" target="$2" mode="$3"
  mcf_change install -m "$mode" -o "$mcf_owner" -g "$mcf_group" -- "$source" "$target.new" \
    && mcf_change mv -Tf -- "$target.new" "$target"
}

# The unit's processes: every pid in its control group.
mcf_unit_pids() {
  local cgroup
  cgroup="$(systemctl show --property=ControlGroup --value "$mcf_service" 2>/dev/null || true)"
  [[ "$cgroup" == /* ]] || return 1
  cat "$(mcf_path /sys/fs/cgroup)$cgroup/cgroup.procs" 2>/dev/null
}

# The heartbeat probe's script, run by node inside a transient unit that loads
# only the database credential. It prints one JSON line and never the URL or a
# driver message.
mcf_heartbeat_probe_script() {
  cat <<'NODE'
'use strict';
const { createRequire } = require('node:module');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const [app, workerId] = process.argv.slice(2);
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
(async () => {
  let sql = null;
  try {
    const url = readFileSync(join(process.env.CREDENTIALS_DIRECTORY ?? '', 'database-url'), 'utf8').trim();
    const postgres = createRequire(join(app, 'node_modules/@wizard-ads/db/package.json'))('postgres');
    sql = postgres(url, { max: 1, connect_timeout: 15, idle_timeout: 1, prepare: false, onnotice: () => {} });
    const rows = await sql`select extract(epoch from (now() - beat_at))::bigint as age, preview_enabled,
      dispatch_enabled, cardinality(scope) as scope_entries, worker_revision
      from app.creator_mcf_worker_heartbeats where worker_id = ${workerId}`;
    if (rows.length === 0) emit({ status: 'absent' });
    else emit({ status: 'ok', ageSeconds: Number(rows[0].age), previewEnabled: rows[0].preview_enabled === true,
      dispatchEnabled: rows[0].dispatch_enabled === true, scopeEntries: Number(rows[0].scope_entries),
      workerRevision: String(rows[0].worker_revision) });
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : 'unavailable';
    emit({ status: 'unreadable', code });
  } finally {
    if (sql !== null) await sql.end({ timeout: 5 }).catch(() => {});
  }
})();
NODE
}

mcf_heartbeat_probe() {
  local release="$1" worker_id="$2"
  mcf_heartbeat_probe_script | sudo systemd-run --quiet --wait --pipe --collect \
    --property=DynamicUser=yes --property=ProtectSystem=strict --property=ProtectHome=yes \
    --property=PrivateTmp=yes --property=ProtectProc=invisible --property=NoNewPrivileges=yes \
    --property=LimitCORE=0 --property=MemorySwapMax=0 \
    "--property=LoadCredentialEncrypted=database-url:$mcf_credstore/wizard-ads-database-url.cred" \
    "$mcf_node" - "$release/app" "$worker_id"
}
