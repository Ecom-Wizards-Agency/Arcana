#!/usr/bin/env bash
# Read-only check of wizard-ads-mcf.service on the Evo (WP-338f). Run it from a
# clean checkout of the release revision:
#
#   bash docs/deploy/verify-mcf-evo-systemd.sh --revision <full-git-object-id>
#
# It prints and checks the unit's state and hardening, each process's core-file
# limit and coredump filter, its swap limit, that it listens on no port, the
# kernel core_pattern, the runtime start line and the heartbeat row (its age,
# flags, scope size and revision). The unit opens no listener, so the heartbeat
# row is its health signal. Changes nothing; exits 1 on any mismatch.
set -euo pipefail

expected_revision=
while (($# > 0)); do
  case "$1" in
    --revision)
      expected_revision="${2:-}"
      shift 2 || { echo "usage: $0 --revision <full-git-object-id>" >&2; exit 2; }
      ;;
    *)
      echo "usage: $0 --revision <full-git-object-id>" >&2
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
failures=0
fail() {
  printf 'FAIL: %s\n' "$*" >&2
  failures=$((failures + 1))
}

for command in cmp find git python3 sha256sum ss sudo systemctl systemd-run journalctl; do
  command -v "$command" >/dev/null || { echo "refusing: required command is unavailable: $command" >&2; exit 1; }
done
if ! mcf_assert_checkout "$expected_revision" "$script_dir"; then
  echo "refusing: run this from a clean checkout whose HEAD is $expected_revision" >&2
  exit 1
fi

# Files: the release, the unit, the drop-in, the configuration and isolation.
mcf_assert_release "$expected_revision" "$script_dir" || fail "release"
release="$(mcf_release_dir "$expected_revision")"
if ! sudo cmp -s "$script_dir/wizard-ads-mcf.service" "$(mcf_path "$mcf_unit")"; then
  fail "the installed unit differs from this checkout's wizard-ads-mcf.service"
fi
key_ids="$(mcf_recipient_key_ids)" || fail "recipient key files"
mapfile -t recipient_ids < <(printf '%s' "${key_ids:-}" | sed '/^$/d')
if ! diff -q <(mcf_dropin_text "${recipient_ids[@]}") <(sudo cat "$(mcf_path "$mcf_dropin")" 2>/dev/null) >/dev/null; then
  fail "the recipient-key drop-in does not list exactly the key files in the store; rerun the install"
fi
mcf_assert_static_credentials || fail "static credentials"
mcf_assert_key_isolation || fail "credential isolation"
config_summary="$(mcf_check_config "$release/credential_runtime.py" "$(mcf_path "$mcf_config")")" \
  || { fail "configuration"; config_summary='{"preview":false,"dispatch":false,"scopeEntries":-1,"workerId":"wizard-ads-mcf"}'; }
echo "configuration: $config_summary"
echo "recipient keys loaded by the drop-in: ${#recipient_ids[@]}"

# The unit: enabled, active and hardened as written.
show() { systemctl show --property="$1" --value "$mcf_service" 2>/dev/null || true; }
[[ "$(systemctl is-enabled "$mcf_service" 2>/dev/null || true)" == enabled ]] || fail "$mcf_service is not enabled"
[[ "$(systemctl is-active "$mcf_service" 2>/dev/null || true)" == active ]] || fail "$mcf_service is not active"
for expectation in DynamicUser=yes ProtectProc=invisible ProcSubset=pid LimitCORE=0 LimitCORESoft=0 \
  MemorySwapMax=0 CoredumpFilter=0x10; do
  property="${expectation%%=*}"
  actual="$(show "$property")"
  printf '%s: %s\n' "$property" "$actual"
  [[ "$actual" == "${expectation#*=}" ]] || fail "$property is '$actual', expected '${expectation#*=}'"
done
echo "TimeoutStopUSec: $(show TimeoutStopUSec)"

# Every process: core-file limit 0, coredump filter elf-headers only, a dynamic
# user id, and no TCP or UDP listener.
mapfile -t pids < <(mcf_unit_pids || true)
((${#pids[@]} > 0)) || fail "no process runs in $mcf_service"
listeners="$(sudo ss -H -l -n -p -t -u 2>/dev/null || true)"
runtime_uid="$(id -u wizard-ads-runtime 2>/dev/null || echo none)"
for pid in "${pids[@]}"; do
  [[ "$pid" =~ ^[0-9]+$ ]] || { fail "unreadable process id"; continue; }
  limit="$(sudo grep -E '^Max core file size' "$(mcf_path "/proc/$pid/limits")" 2>/dev/null || true)"
  printf 'pid %s: %s\n' "$pid" "${limit:-limits unreadable}"
  [[ "$limit" =~ ^Max\ core\ file\ size\ +0\ +0\ +bytes ]] || fail "pid $pid may dump core"
  filter="$(sudo cat "$(mcf_path "/proc/$pid/coredump_filter")" 2>/dev/null || true)"
  printf 'pid %s: coredump_filter %s\n' "$pid" "${filter:-unreadable}"
  [[ "$filter" == 00000010 ]] || fail "pid $pid coredump_filter is not elf-headers only"
  uid="$(sudo awk '$1 == "Uid:" { print $2 }' "$(mcf_path "/proc/$pid/status")" 2>/dev/null || true)"
  if [[ ! "$uid" =~ ^[0-9]+$ ]] || ((uid < 61184 || uid > 65519)) || [[ "$uid" == "$runtime_uid" ]]; then
    fail "pid $pid does not run as a dynamic user"
  fi
  if grep -q "pid=$pid," <<<"$listeners"; then
    fail "pid $pid listens on a TCP or UDP port"
  fi
done
cgroup="$(show ControlGroup)"
swap="$(cat "$(mcf_path /sys/fs/cgroup)$cgroup/memory.swap.max" 2>/dev/null || true)"
echo "memory.swap.max: ${swap:-unreadable}"
[[ "$swap" == 0 ]] || fail "the unit's control group may swap"

# The kernel's core_pattern, for the design's open question (DESIGN section 19).
core_pattern="$(cat "$(mcf_path /proc/sys/kernel/core_pattern)" 2>/dev/null || true)"
echo "kernel core_pattern: ${core_pattern:-unreadable}"
case "$core_pattern" in
  '|'*systemd-coredump*)
    echo "core_pattern pipes to systemd-coredump, which stores nothing for a process whose core limit is 0; the unit's coredump filter also leaves only ELF headers" ;;
  '|'*)
    echo "core_pattern pipes to another handler: check by hand that it honours a core limit of 0; the unit's coredump filter leaves only ELF headers" ;;
  '')
    fail "kernel core_pattern is unreadable" ;;
  *)
    echo "core_pattern writes a file: the kernel writes nothing for a process whose core limit is 0" ;;
esac

# The runtime start line and the MCF entry's own start, since the last start.
journal="$(sudo journalctl -u "$mcf_service" -b --no-pager -o cat -n 2000 2>/dev/null || true)"
read -r -d '' journal_check <<'PY' || true
import json, sys
revision = sys.argv[1]
events = []
for line in sys.stdin.read().splitlines():
    try:
        value = json.loads(line)
    except ValueError:
        continue
    if isinstance(value, dict):
        events.append(value)
starts = [i for i, e in enumerate(events) if e.get("event") == "wizard_ads_runtime_start"]
if not starts:
    sys.exit("no runtime start line in this boot's journal")
start = events[starts[-1]]
if start.get("mode") != "mcf" or start.get("revision") != revision:
    sys.exit("the last runtime start line is not mode mcf at this revision")
after = [e.get("event") for e in events[starts[-1] + 1:]]
if "mcf_start_refused" in after:
    sys.exit("mcf-main refused to start after the last runtime start")
if "mcf_start" not in after:
    sys.exit("mcf-main has not logged mcf_start since the last runtime start")
print(json.dumps({k: start[k] for k in sorted(start) if k.startswith("mcf")}, separators=(",", ":")),
      "heartbeat failures since start:", after.count("mcf_heartbeat_failed"))
PY
if ! start_check="$(python3 -c "$journal_check" "$expected_revision" <<<"$journal" 2>&1)"; then
  fail "journal: $start_check"
else
  echo "runtime start: $start_check"
fi

# The heartbeat row: the unit's health signal.
worker_id="$(mcf_json_field "$config_summary" workerId)"
heartbeat="$(mcf_heartbeat_probe "$release" "$worker_id" 2>/dev/null | tail -n 1 || true)"
if ! heartbeat_check="$(python3 - "$heartbeat" "$config_summary" "$expected_revision" 2>&1 <<'PY'
import json, sys
try:
    beat = json.loads(sys.argv[1])
except ValueError:
    sys.exit("the heartbeat probe printed no result")
config, revision = json.loads(sys.argv[2]), sys.argv[3]
if beat.get("status") == "absent":
    sys.exit("no heartbeat row for this worker id yet")
if beat.get("status") != "ok":
    sys.exit(f"the heartbeat row is not readable with the unit's database role (code {beat.get('code')}); "
             "read it with the SQL in always-on-worker.md")
problems = []
if not 0 <= beat["ageSeconds"] <= 120:
    problems.append(f"age {beat['ageSeconds']} s is over 120 s")
if beat["workerRevision"] != revision:
    problems.append("revision differs from the release")
if (beat["previewEnabled"], beat["dispatchEnabled"]) != (config["preview"], config["dispatch"]):
    problems.append("flags differ from the configuration")
if beat["scopeEntries"] != config["scopeEntries"]:
    problems.append("scope size differs from the configuration")
print(f"age {beat['ageSeconds']} s, revision {beat['workerRevision']}, "
      f"preview {'on' if beat['previewEnabled'] else 'off'}, dispatch {'on' if beat['dispatchEnabled'] else 'off'}, "
      f"scope entries {beat['scopeEntries']}")
if problems:
    sys.exit("; ".join(problems))
PY
)"; then
  fail "heartbeat: $heartbeat_check"
else
  echo "heartbeat: $heartbeat_check"
fi

if ((failures > 0)); then
  echo "$mcf_service verification failed ($failures problem(s))" >&2
  exit 1
fi
echo "$mcf_service verified at revision $expected_revision"
