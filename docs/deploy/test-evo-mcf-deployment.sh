#!/usr/bin/env bash
# Static and dry-run proof for the Evo MCF send unit (WP-338f): the mcf runtime
# mode, wizard-ads-mcf.service, its template, credential isolation between units,
# and install-, verify- and rollback-mcf-evo-systemd.sh run against a fixture root
# with stubbed sudo, systemctl, systemd-run, systemd-analyze, journalctl and ss.
# Needs no privileges, credentials, host configuration, database or network.
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
runtime="$script_dir/wizard-ads-credential-runtime.py"
runtime_test="$script_dir/test-evo-mcf-runtime.py"
unit="$script_dir/wizard-ads-mcf.service"
worker_unit="$script_dir/wizard-ads-worker.service"
spapi_unit="$script_dir/wizard-ads-spapi-connections.service"
amazon_unit="$script_dir/wizard-ads-amazon-connections.service"
report_unit="$script_dir/openspell-report-worker.service"
template="$script_dir/wizard-ads-mcf.TEMPLATE.json"
lib="$script_dir/mcf-evo-systemd-lib.sh"
installer="$script_dir/install-mcf-evo-systemd.sh"
verifier="$script_dir/verify-mcf-evo-systemd.sh"
rollback="$script_dir/rollback-mcf-evo-systemd.sh"
generator="$script_dir/generate-mcf-recipient-key-evo.sh"
runbook="$script_dir/always-on-worker.md"
release_path=/usr/local/lib/wizard-ads-runtime/worker-current

for script in "$lib" "$installer" "$verifier" "$rollback" "$generator" "$0"; do
  bash -n "$script"
done
python3 -B -c 'import ast, sys
for path in sys.argv[1:]:
    ast.parse(open(path, encoding="utf-8").read(), path)' "$runtime" "$runtime_test"

# 1. The mcf runtime tests: every declared test runs and passes.
declared_tests="$(grep -c '^    def test_' "$runtime_test")"
test_output="$(python3 -B "$runtime_test" 2>&1)" || {
  printf '%s\n' "$test_output" >&2
  echo "mcf runtime tests failed" >&2
  exit 1
}
ran_tests="$(printf '%s\n' "$test_output" | sed -n 's/^Ran \([0-9][0-9]*\) tests\{0,1\} in .*/\1/p')"
if [[ "$ran_tests" != "$declared_tests" || "$declared_tests" -lt 1 ]] \
  || ! printf '%s\n' "$test_output" | grep -qx 'OK'; then
  echo "mcf runtime tests ran $ran_tests of $declared_tests declared" >&2
  exit 1
fi

# 2. The unit, exactly: no directive may be added, repeated, reordered or dropped.
expected_unit='[Unit]
Description=Wizard Ads MCF send worker with a dynamic user and an encrypted recipient key
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=30min
StartLimitBurst=6
[Service]
Type=exec
DynamicUser=yes
ExecStart=/usr/local/lib/wizard-ads-runtime/worker-current/credential_runtime.py mcf
LoadCredentialEncrypted=database-url:/etc/credstore.encrypted/wizard-ads-database-url.cred
LoadCredentialEncrypted=spapi-lwa-client-id:/etc/credstore.encrypted/wizard-ads-spapi-lwa-client-id.cred
LoadCredentialEncrypted=spapi-lwa-client-secret-value:/etc/credstore.encrypted/wizard-ads-spapi-lwa-client-secret-value.cred
StateDirectory=wizard-ads-mcf
StateDirectoryMode=0700
Restart=on-failure
RestartSec=30s
RestartSteps=6
RestartMaxDelaySec=15min
TimeoutStartSec=90s
TimeoutStopSec=150s
KillSignal=SIGTERM
LimitCORE=0
CoredumpFilter=elf-headers
MemorySwapMax=0
UMask=0077
NoNewPrivileges=yes
PrivateDevices=yes
PrivateTmp=yes
ProtectClock=yes
ProtectControlGroups=yes
ProtectHome=yes
ProtectHostname=yes
ProtectKernelLogs=yes
ProtectKernelModules=yes
ProtectKernelTunables=yes
ProtectProc=invisible
ProtectSystem=strict
ProcSubset=pid
RemoveIPC=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
SystemCallArchitectures=native
CapabilityBoundingSet=
AmbientCapabilities=
DevicePolicy=closed
TasksMax=256
LimitNOFILE=8192
[Install]
WantedBy=multi-user.target'
actual_unit="$(grep -v -e '^#' -e '^[[:space:]]*$' "$unit")"
if [[ "$actual_unit" != "$expected_unit" ]]; then
  echo "wizard-ads-mcf.service differs from its expected shape" >&2
  diff <(printf '%s\n' "$expected_unit") <(printf '%s\n' "$actual_unit") >&2 || true
  exit 1
fi
if [[ "$(grep -c "^ExecStart=$release_path/credential_runtime.py mcf\$" "$unit")" != 1 ]]; then
  echo "wizard-ads-mcf.service must run the release runtime's mcf mode" >&2
  exit 1
fi
stop_value="$(awk -F= '$1 == "TimeoutStopSec" { print $2 }' "$unit")"
stop_seconds="${stop_value%s}"
if [[ ! "$stop_value" =~ ^[0-9]+s$ ]] || ((stop_seconds < 120)); then
  echo "TimeoutStopSec must be at least 120 s" >&2
  exit 1
fi
# The report worker's hardening lines, each present verbatim.
hardening_names=(Type DynamicUser UMask NoNewPrivileges 'Private[A-Za-z]+' 'Protect[A-Za-z]+' ProcSubset RemoveIPC
  'Restrict[A-Za-z]+' LockPersonality SystemCallArchitectures CapabilityBoundingSet AmbientCapabilities DevicePolicy
  TasksMax LimitNOFILE KillSignal StateDirectoryMode)
hardening_pattern="^($(IFS='|'; printf '%s' "${hardening_names[*]}"))="
hardening_count=0
while IFS= read -r line; do
  if ! grep -Fqx -- "$line" "$unit"; then
    echo "wizard-ads-mcf.service lacks the report worker's hardening line: $line" >&2
    exit 1
  fi
  hardening_count=$((hardening_count + 1))
done < <(grep -E "$hardening_pattern" "$report_unit")
if ((hardening_count != 30)); then
  echo "expected 30 report worker hardening lines, found $hardening_count" >&2
  exit 1
fi
if grep -En '^(User|Group|Environment|EnvironmentFile|ExecStartPre|ExecStartPost|ListenStream|ListenDatagram|Sockets|ImportCredential|SetCredential)' "$unit"; then
  echo "wizard-ads-mcf.service has a user, environment, listener or extra credential directive" >&2
  exit 1
fi

# 3. Credential lines equal the runtime's mcf mapping, and nothing else.
runtime_value() {
  python3 -B - "$runtime" "$1" <<'PY'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("credential_runtime", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
value = getattr(module, sys.argv[2])
for item in sorted(value):
    print(item)
PY
}
mcf_credentials="$(runtime_value MCF_CREDENTIALS)"
if [[ "$mcf_credentials" != $'database-url\nspapi-lwa-client-id\nspapi-lwa-client-secret-value' ]]; then
  echo "the runtime's mcf credential mapping changed" >&2
  exit 1
fi
unit_credentials="$(awk -F '[=:]' '$1 == "LoadCredentialEncrypted" { print $2 }' "$unit" | LC_ALL=C sort)"
if [[ "$unit_credentials" != "$mcf_credentials" ]]; then
  echo "wizard-ads-mcf.service credential names do not equal the mcf mapping" >&2
  exit 1
fi

# 4. Isolation between units. Only the MCF unit's comments name a recipient key;
# only the general worker names the webhook, once, as an optional store name;
# no unit but the MCF unit carries a send key.
for other in "$worker_unit" "$spapi_unit" "$amazon_unit" "$report_unit"; do
  if grep -n 'mcf-recipient' "$other"; then
    echo "$(basename "$other") names a recipient key" >&2
    exit 1
  fi
done
if grep -v '^#' "$unit" | grep -n 'mcf-recipient\|mcf-alert-webhook\|ads-lwa'; then
  echo "wizard-ads-mcf.service loads a recipient key, the webhook or an Ads credential in the tracked unit" >&2
  exit 1
fi
webhook_line="LoadCredentialEncrypted="
webhook_line+="mcf-alert-webhook:"
webhook_line+="wizard-ads-mcf-alert-webhook.cred"
if [[ "$(grep -Fxc -- "$webhook_line" "$worker_unit")" != 1 ]] \
  || [[ "$(grep -c 'mcf-alert-webhook' "$worker_unit")" != 1 ]]; then
  echo "wizard-ads-worker.service must load the optional webhook exactly once, by store name" >&2
  exit 1
fi
for other in "$spapi_unit" "$amazon_unit" "$unit"; do
  if grep -v '^#' "$other" | grep -q 'mcf-alert-webhook'; then
    echo "$(basename "$other") loads the webhook" >&2
    exit 1
  fi
done
send_key_pattern='OPENSPELL_MCF_(PREVIEW_ENABLED|DISPATCH_ENABLED|SCOPE|POLL_INTERVAL_MS)'
if grep -En "$send_key_pattern" "$worker_unit" "$spapi_unit" "$amazon_unit" "$script_dir/wizard-ads-worker.TEMPLATE.json"; then
  echo "a general-worker file names an MCF send key" >&2
  exit 1
fi

# 5. The template: flags off, a placeholder scope, only mcf keys, no secret.
python3 -B - "$runtime" "$template" <<'PY'
import importlib.util, json, re, sys
spec = importlib.util.spec_from_file_location("credential_runtime", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
config = json.load(open(sys.argv[2], encoding="utf-8"))
def fail(message):
    sys.exit(f"wizard-ads-mcf.TEMPLATE.json: {message}")
if not isinstance(config, dict) or not all(isinstance(v, str) for v in config.values()):
    fail("must be an object of strings")
if set(config) != {"OPENSPELL_MCF_PREVIEW_ENABLED", "OPENSPELL_MCF_DISPATCH_ENABLED", "OPENSPELL_MCF_SCOPE"} \
        or not set(config) <= module.MCF_ENV_KEYS:
    fail("must hold exactly the two flags and the scope")
if config["OPENSPELL_MCF_PREVIEW_ENABLED"] != "0" or config["OPENSPELL_MCF_DISPATCH_ENABLED"] != "0":
    fail("both flags must be off")
if not re.fullmatch(r"<[^<>]+>:<[^<>]+>", config["OPENSPELL_MCF_SCOPE"]):
    fail("the scope must stay a placeholder")
for value in config.values():
    if re.search(r"[0-9a-f]{8}-[0-9a-f]{4}|postgres" + r"|https?://|[A-Za-z0-9+=_-]{24,}", value):
        fail("contains an identifier- or secret-shaped value")
PY

# 6. The unit is a valid systemd definition, with no warning (systemd-analyze exits
# 0 on an ignored line, so its output must be empty).
test_tmp="$(mktemp -d "${TMPDIR:-/tmp}/wizard-ads-evo-mcf-test.XXXXXX")"
cleanup() {
  case "$test_tmp" in
    */wizard-ads-evo-mcf-test.*)
      chmod -R u+rwX "$test_tmp" 2>/dev/null || true
      find "$test_tmp" -depth -delete 2>/dev/null || true
      ;;
  esac
}
trap cleanup EXIT
install -d -m 0700 "$test_tmp/systemd"
sed -e 's#^ExecStart=.*#ExecStart=/bin/true#' "$unit" >"$test_tmp/systemd/wizard-ads-mcf.service"
analysis="$(systemd-analyze verify "$test_tmp/systemd/wizard-ads-mcf.service" 2>&1)"
if [[ -n "$analysis" ]]; then
  printf '%s\n' "$analysis" >&2
  echo "systemd-analyze reports a problem with wizard-ads-mcf.service" >&2
  exit 1
fi

# 7. Public-repository hygiene of the new files.
private_locator_pattern='op:/''/'
new_files=("$unit" "$template" "$lib" "$installer" "$verifier" "$rollback" "$generator" "$runtime_test")
if rg -n -- "/home/|/Users/|$private_locator_pattern" "${new_files[@]}"; then
  echo "an MCF deployment file contains a home path or private locator" >&2
  exit 1
fi
if rg -n --pcre2 '(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}' \
  "$unit" "$template" "$lib" "$installer" "$verifier" "$rollback" "$generator"; then
  echo "an MCF deployment file contains a key id or a uuid" >&2
  exit 1
fi
for step in 'generate-mcf-recipient-key-evo.sh' 'systemd-creds encrypt --with-key=host+tpm2' 'rollback-mcf-evo-systemd.sh --remove' 'OPENSPELL_MCF_RECIPIENT_PUBLIC_KEY' \
  'creator-mcf-grant-seed.TEMPLATE.sql' 'install-mcf-evo-systemd.sh' 'verify-mcf-evo-systemd.sh' \
  'rollback-mcf-evo-systemd.sh' 'creator_mcf_worker_heartbeats' 'Kill switch' 'Static user fallback' \
  'Rotation' 'Destruction' 'revoked_at'; do
  if ! grep -Fq -- "$step" "$runbook"; then
    echo "always-on-worker.md does not cover: $step" >&2
    exit 1
  fi
done

# 8. The scripts against a fixture root. A fixture repository holds a copy of
# docs/deploy at one commit; the fixture Evo holds that commit's release, the
# credential store and systemd's state. Stubs log every call.
fixture_repo="$test_tmp/repo"
install -d "$fixture_repo/docs/deploy"
for file in "$lib" "$installer" "$verifier" "$rollback" "$generator" "$unit" "$runtime" "$template"; do
  install -m 0644 "$file" "$fixture_repo/docs/deploy/$(basename "$file")"
done
git -C "$fixture_repo" init -q
git -C "$fixture_repo" add docs/deploy
git -C "$fixture_repo" -c user.name=fixture -c user.email=fixture@example.invalid commit -qm fixture
revision="$(git -C "$fixture_repo" rev-parse HEAD)"
fixture_scripts="$fixture_repo/docs/deploy"

root="$test_tmp/root"
state="$test_tmp/state"
stubs="$test_tmp/bin"
install -d "$root" "$state" "$stubs" "$state/probe-credentials"
release="$root/usr/local/lib/wizard-ads-runtime/worker-releases/$revision"
install -d "$release/app/src" "$release/app/node_modules/tsx/dist" "$release/app/node_modules/.bin" \
  "$release/app/node_modules/@wizard-ads/db" "$release/app/node_modules/postgres"
printf '%s\n' "$revision" >"$release/REVISION"
install -m 0755 "$runtime" "$release/credential_runtime.py"
printf 'export {};\n' >"$release/app/src/mcf-main.ts"
printf 'export {};\n' >"$release/app/node_modules/tsx/dist/cli.mjs"
ln -s ../tsx/dist/cli.mjs "$release/app/node_modules/.bin/tsx"
printf '{"name":"@wizard-ads/db","version":"0.0.0"}\n' >"$release/app/node_modules/@wizard-ads/db/package.json"
printf '{"name":"postgres","version":"0.0.0","main":"index.js"}\n' >"$release/app/node_modules/postgres/package.json"
# A stand-in driver: answers the heartbeat query from a fixture file.
cat >"$release/app/node_modules/postgres/index.js" <<'NODE'
'use strict';
const { readFileSync } = require('node:fs');
module.exports = function postgres(url) {
  if (!/^postgres(ql)?:\/\//.test(url)) throw Object.assign(new Error(url), { code: 'XXBAD' });
  const sql = async (strings, ...values) => {
    const beat = JSON.parse(readFileSync(process.env.MCF_FIXTURE_HEARTBEAT, 'utf8'));
    if (beat.error) throw Object.assign(new Error(`fixture ${url}`), { code: beat.error });
    if (!strings.join('?').includes('app.creator_mcf_worker_heartbeats') || values[0] !== beat.workerId) return [];
    return [beat.row];
  };
  sql.end = async () => {};
  return sql;
};
NODE
(cd "$release" && find . -type l -printf '%P\t%l\n' | LC_ALL=C sort >ARTIFACT_LINKS)
(cd "$release" && find . -type f ! -name ARTIFACT_SHA256 -printf '%P\n' | LC_ALL=C sort \
  | while IFS= read -r file; do sha256sum "./$file"; done >"$test_tmp/ARTIFACT_SHA256")
mv "$test_tmp/ARTIFACT_SHA256" "$release/ARTIFACT_SHA256"
find "$release" -type d -exec chmod 0755 {} +
find "$release" -type f -exec chmod 0644 {} +
chmod 0755 "$release/credential_runtime.py"
ln -s "worker-releases/$revision" "$root/usr/local/lib/wizard-ads-runtime/worker-current"
install -d -m 0755 "$root/etc/credstore.encrypted" "$root/etc/systemd/system" "$root/run/lock" \
  "$root/proc/sys/kernel" "$root/sys/fs/cgroup/system.slice/wizard-ads-mcf.service"
for name in database-url spapi-lwa-client-id spapi-lwa-client-secret-value; do
  printf 'synthetic-encrypted-%s\n' "$name" >"$root/etc/credstore.encrypted/wizard-ads-$name.cred"
done
key_one="0badc0de"
key_two="feedf00d"
printf 'synthetic-encrypted-key\n' >"$root/etc/credstore.encrypted/wizard-ads-mcf-recipient-$key_one.cred"
chmod 0600 "$root/etc/credstore.encrypted/"*.cred
install -m 0644 "$worker_unit" "$root/etc/systemd/system/wizard-ads-worker.service"
install -d -m 0755 "$root/run/systemd/system" "$root/usr/lib/systemd/system"
# A distribution unit's own glob must not be mistaken for a recipient-key import.
printf '[Service]\nImportCredential=tmpfiles.*\nImportCredential=login.*:renamed.\n' \
  >"$root/usr/lib/systemd/system/systemd-tmpfiles-setup.service"
: >"$root/run/lock/wizard-ads-mcf-deployment.lock"
printf '%s\n' '|/usr/lib/systemd/systemd-coredump %P %u %g %s %t %c %h' >"$root/proc/sys/kernel/core_pattern"
cgroup_dir="$root/sys/fs/cgroup/system.slice/wizard-ads-mcf.service"
printf '4242\n4243\n' >"$cgroup_dir/cgroup.procs"
printf '0\n' >"$cgroup_dir/memory.swap.max"
write_process() {
  local pid="$1" core="$2" uid="$3"
  install -d "$root/proc/$pid"
  printf 'Limit                     Soft Limit           Hard Limit           Units     \nMax core file size        %s                    %s                    bytes     \n' \
    "$core" "$core" >"$root/proc/$pid/limits"
  printf '00000010\n' >"$root/proc/$pid/coredump_filter"
  printf 'Name:\tnode\nUid:\t%s\t%s\t%s\t%s\n' "$uid" "$uid" "$uid" "$uid" >"$root/proc/$pid/status"
}
write_process 4242 0 61234
write_process 4243 0 61234
database_canary="postgres""ql://synthetic:fixture@""127.0.0.1:5432/canary-database"
printf '%s\n' "$database_canary" >"$state/probe-credentials/database-url"
printf 'absent\n' >"$state/enabled"
printf 'inactive\n' >"$state/active"
printf 'LISTEN 0 4096 127.0.0.1:3777 0.0.0.0:* users:(("node",pid=999,fd=20))\n' >"$state/listeners"
write_heartbeat() {
  printf '{"workerId":"wizard-ads-mcf","row":{"age":"%s","preview_enabled":false,"dispatch_enabled":false,"scope_entries":0,"worker_revision":"%s"}%s}\n' \
    "$1" "$2" "${3:-}" >"$state/heartbeat.json"
}
write_heartbeat 12 "$revision"
write_journal() {
  printf '{"event":"wizard_ads_runtime_start","mode":"mcf","revision":"%s","spapiConnectionLoop":"disabled","mcfPreview":"disabled","mcfDispatch":"disabled","mcfScopeEntries":0,"mcfRecipientKeys":1}\n' \
    "$revision" >"$state/journal"
  local next='{"level":"info","event":"mcf_start"}'
  printf '%s\n' "${1:-$next}" >>"$state/journal"
}
write_journal

cat >"$stubs/sudo" <<'SH'
#!/usr/bin/env bash
printf 'sudo %s\n' "$*" >>"$MCF_FIXTURE_STATE/calls"
exec "$@"
SH
cat >"$stubs/systemctl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
s="$MCF_FIXTURE_STATE"
printf 'systemctl %s\n' "$*" >>"$s/calls"
unit_file="$MCF_EVO_ROOT/etc/systemd/system/wizard-ads-mcf.service"
case "$1" in
  --version) echo "systemd 259 (fixture)" ;;
  is-enabled) state="$(cat "$s/enabled")"; [[ "$state" == absent ]] || echo "$state"; [[ "$state" == enabled ]] ;;
  is-active) cat "$s/active"; [[ "$(cat "$s/active")" == active ]] ;;
  daemon-reload) : ;;
  enable) [[ -f "$unit_file" ]] || exit 1; echo enabled >"$s/enabled" ;;
  disable) echo disabled >"$s/enabled" ;;
  start|restart) [[ -f "$unit_file" ]] || exit 5; [[ ! -e "$s/fail-start" ]] || exit 1; echo active >"$s/active" ;;
  stop) echo inactive >"$s/active" ;;
  show)
    property="${2#--property=}"
    case "$property" in
      ControlGroup) echo /system.slice/wizard-ads-mcf.service ;;
      TimeoutStopUSec) echo "2min 30s" ;;
      *) sed -n "s/^$property=//p" "$s/props" ;;
    esac
    ;;
  *) echo "fixture systemctl: unexpected $*" >&2; exit 64 ;;
esac
SH
cat >"$stubs/systemd-analyze" <<'SH'
#!/usr/bin/env bash
printf 'systemd-analyze %s\n' "$*" >>"$MCF_FIXTURE_STATE/calls"
[[ ! -e "$MCF_FIXTURE_STATE/analyze" ]] || cat "$MCF_FIXTURE_STATE/analyze" >&2
exit 0
SH
cat >"$stubs/systemd-run" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
s="$MCF_FIXTURE_STATE"
printf 'systemd-run %s\n' "$*" >>"$s/calls"
credentials=false
while (($# > 0)) && [[ "$1" == --* ]]; do
  [[ "$1" != --property=LoadCredentialEncrypted=* ]] || credentials=true
  shift
done
if [[ "$credentials" == true ]]; then
  # The heartbeat probe: node reads the database credential from its directory.
  [[ "$1" == /usr/local/bin/node ]] || exit 64
  shift
  CREDENTIALS_DIRECTORY="$s/probe-credentials" MCF_FIXTURE_HEARTBEAT="$s/heartbeat.json" exec node "$@"
fi
if [[ -e "$s/unreadable" ]]; then
  cat "$s/unreadable"
  exit 0
fi
exec "$@"
SH
cat >"$stubs/journalctl" <<'SH'
#!/usr/bin/env bash
cat "$MCF_FIXTURE_STATE/journal"
SH
cat >"$stubs/ss" <<'SH'
#!/usr/bin/env bash
cat "$MCF_FIXTURE_STATE/listeners"
SH
chmod 0755 "$stubs/"*
printf '%s\n' DynamicUser=yes ProtectProc=invisible ProcSubset=pid LimitCORE=0 LimitCORESoft=0 \
  MemorySwapMax=0 CoredumpFilter=0x10 >"$state/props"

export MCF_EVO_ROOT="$root" MCF_FIXTURE_STATE="$state"
export PATH="$stubs:$PATH"
mutation_pattern='^(sudo (install|mv|cp|touch|tee|rm|ln|chmod|chown) |systemctl (daemon-reload|enable|disable|start|stop|restart))'
snapshot() {
  (cd "$root" && find . -path ./run/lock -prune -o -printf '%p %m %s %l\n' | LC_ALL=C sort | sha256sum)
}
run_script() {
  : >"$state/calls"
  run_output="$(cd "$fixture_scripts" && bash "$@" 2>&1)"
}
expect_success() {
  local label="$1"
  shift
  if ! run_script "$@"; then
    printf '%s\n' "$run_output" >&2
    echo "fixture: $label failed" >&2
    exit 1
  fi
}
expect_refusal() {
  local label="$1" fragment="$2"
  shift 2
  local before
  before="$(snapshot)"
  if run_script "$@"; then
    printf '%s\n' "$run_output" >&2
    echo "fixture: $label was accepted" >&2
    exit 1
  fi
  if [[ "$run_output" != *"$fragment"* ]]; then
    printf '%s\n' "$run_output" >&2
    echo "fixture: $label refused for another reason (expected: $fragment)" >&2
    exit 1
  fi
  if grep -Eq "$mutation_pattern" "$state/calls"; then
    echo "fixture: $label changed something before refusing" >&2
    exit 1
  fi
  if [[ "$(snapshot)" != "$before" ]]; then
    echo "fixture: $label changed the fixture root" >&2
    exit 1
  fi
  refusals=$((refusals + 1))
}
refusals=0
fixture_runs=0
installer_fixture="$fixture_scripts/install-mcf-evo-systemd.sh"
verifier_fixture="$fixture_scripts/verify-mcf-evo-systemd.sh"
rollback_fixture="$fixture_scripts/rollback-mcf-evo-systemd.sh"

# 8a. A dry-run install changes nothing and says what it would do.
before="$(snapshot)"
expect_success "install --dry-run" "$installer_fixture" --revision "$revision" --dry-run
if grep -Eq "$mutation_pattern" "$state/calls" || [[ "$(snapshot)" != "$before" ]] \
  || [[ "$run_output" != *"dry run complete"* ]] \
  || [[ "$(grep -c '^dry-run: would run:' <<<"$run_output")" -lt 8 ]]; then
  printf '%s\n' "$run_output" >&2
  echo "fixture: install --dry-run changed something or printed no plan" >&2
  exit 1
fi
fixture_runs=$((fixture_runs + 1))

# 8b. A host with no ImportCredential= line at all passes the isolation check.
mv "$root/usr/lib/systemd/system/systemd-tmpfiles-setup.service" "$test_tmp/tmpfiles.saved"
expect_success "install --dry-run without ImportCredential lines" "$installer_fixture" --revision "$revision" --dry-run
mv "$test_tmp/tmpfiles.saved" "$root/usr/lib/systemd/system/systemd-tmpfiles-setup.service"
fixture_runs=$((fixture_runs + 1))

# Refusals before any change.
git -C "$fixture_repo" tag fixture-head
printf 'x\n' >"$fixture_repo/untracked"
expect_refusal "dirty checkout" "clean checkout" "$installer_fixture" --revision "$revision"
rm "$fixture_repo/untracked"
expect_refusal "other revision" "clean checkout" "$installer_fixture" --revision "$(printf '1%.0s' {1..40})"
ln -sfn "worker-releases/$(printf '2%.0s' {1..40})" "$root/usr/local/lib/wizard-ads-runtime/worker-current"
expect_refusal "worker-current elsewhere" "upgrade the general worker to this release first" \
  "$installer_fixture" --revision "$revision"
ln -sfn "worker-releases/$revision" "$root/usr/local/lib/wizard-ads-runtime/worker-current"
cp "$release/app/src/mcf-main.ts" "$test_tmp/mcf-main.saved"
printf 'tampered\n' >>"$release/app/src/mcf-main.ts"
expect_refusal "tampered release" "checksums or link manifest" "$installer_fixture" --revision "$revision"
cp "$test_tmp/mcf-main.saved" "$release/app/src/mcf-main.ts"
chmod 0666 "$release/REVISION"
expect_refusal "writable release" "writable by others" "$installer_fixture" --revision "$revision"
chmod 0644 "$release/REVISION"
printf 'Unknown key name in section Service\n%s\n' "wizard-ads-mcf.service:40: fixture warning" >"$state/analyze"
expect_refusal "unit warning" "systemd-analyze reports a problem" "$installer_fixture" --revision "$revision"
rm "$state/analyze"
chmod 0644 "$root/etc/credstore.encrypted/wizard-ads-mcf-recipient-$key_one.cred"
expect_refusal "readable key file" "mode 0400 or 0600" "$installer_fixture" --revision "$revision"
chmod 0600 "$root/etc/credstore.encrypted/wizard-ads-mcf-recipient-$key_one.cred"
printf 'x\n' >"$root/etc/credstore.encrypted/wizard-ads-mcf-recipient-NOTHEX00.cred"
chmod 0600 "$root/etc/credstore.encrypted/wizard-ads-mcf-recipient-NOTHEX00.cred"
expect_refusal "malformed key name" "wizard-ads-mcf-recipient-<keyId8>.cred" "$installer_fixture" --revision "$revision"
rm "$root/etc/credstore.encrypted/wizard-ads-mcf-recipient-NOTHEX00.cred"
mv "$root/etc/credstore.encrypted/wizard-ads-spapi-lwa-client-id.cred" "$test_tmp/lwa.saved"
expect_refusal "missing LWA credential" "missing or not a regular file: wizard-ads-spapi-lwa-client-id.cred" \
  "$installer_fixture" --revision "$revision"
mv "$test_tmp/lwa.saved" "$root/etc/credstore.encrypted/wizard-ads-spapi-lwa-client-id.cred"
cp "$root/etc/systemd/system/wizard-ads-worker.service" "$test_tmp/worker.saved"
printf 'LoadCredentialEncrypted=mcf-recipient-%s:/etc/credstore.encrypted/wizard-ads-mcf-recipient-%s.cred\n' \
  "$key_one" "$key_one" >>"$root/etc/systemd/system/wizard-ads-worker.service"
expect_refusal "key in the general worker" "a unit other than wizard-ads-mcf.service names a recipient key" \
  "$installer_fixture" --revision "$revision"
cp "$test_tmp/worker.saved" "$root/etc/systemd/system/wizard-ads-worker.service"
for glob in 'wizard-ads-*' '*' 'wizard-ads-mcf-*:other.' 'mcf-*'; do
  printf 'ImportCredential=%s\n' "$glob" >>"$root/etc/systemd/system/wizard-ads-worker.service"
  expect_refusal "ImportCredential=$glob" "which matches a recipient key file" "$installer_fixture" --revision "$revision"
  cp "$test_tmp/worker.saved" "$root/etc/systemd/system/wizard-ads-worker.service"
done
printf '[Service]\nImportCredential=*\n' >"$root/usr/lib/systemd/system/fixture-importer.service"
expect_refusal "ImportCredential in /usr/lib" "ImportCredential=*" "$installer_fixture" --revision "$revision"
rm "$root/usr/lib/systemd/system/fixture-importer.service"
printf '[Service]\nLoadCredentialEncrypted=mcf-recipient-%s:x\n' "$key_one" >"$root/run/systemd/system/fixture.service"
expect_refusal "recipient key in /run" "names a recipient key" "$installer_fixture" --revision "$revision"
rm "$root/run/systemd/system/fixture.service"
printf '%s\n' "$release/app/src/mcf-main.ts" >"$state/unreadable"
expect_refusal "unreadable by a dynamic user" "Static user fallback" "$installer_fixture" --revision "$revision"
rm "$state/unreadable"
install -d -m 0755 "$root/etc/wizard-ads-mcf"
printf '{"OPENSPELL_MCF_PREVIEW_ENABLED":"1","OPENSPELL_MCF_SCOPE":"%s:%s"}\n' \
  "0f0e0d0c-0b0a-4908-8706-""050403020100" "SYNTHMKT""0001" >"$root/etc/wizard-ads-mcf/mcf.json"
mv "$root/etc/credstore.encrypted/wizard-ads-mcf-recipient-$key_one.cred" "$test_tmp/key.saved"
expect_refusal "flag without key" "the credential store holds no recipient key" "$installer_fixture" --revision "$revision"
mv "$test_tmp/key.saved" "$root/etc/credstore.encrypted/wizard-ads-mcf-recipient-$key_one.cred"
printf '{"OPENSPELL_MCF_PREVIEW_ENABLED":"0","OPENSPELL_MCF_SCOPE":"not-a-scope"}\n' >"$root/etc/wizard-ads-mcf/mcf.json"
expect_refusal "invalid configuration" "OPENSPELL_MCF_SCOPE must be 1 to 50 distinct" "$installer_fixture" --revision "$revision"
printf '{"WORKER_JOB_TYPES":"mcf.observe"}\n' >"$root/etc/wizard-ads-mcf/mcf.json"
expect_refusal "general key in the configuration" "WORKER_JOB_TYPES belongs to the general worker" \
  "$installer_fixture" --revision "$revision"
rm -r "$root/etc/wizard-ads-mcf"
expect_refusal "rollback without a backup" "no install backup to roll back to" "$rollback_fixture"

# 8c. The first install: a flags-off configuration, the drop-in from the store,
# the unit from the checkout, then enable and start, in that order.
expect_success "first install" "$installer_fixture" --revision "$revision"
fixture_runs=$((fixture_runs + 1))
if ! cmp -s "$unit" "$root/etc/systemd/system/wizard-ads-mcf.service" \
  || [[ "$(cat "$root/etc/systemd/system/wizard-ads-mcf.service.d/recipient-keys.conf")" != "$(printf '%s\n' \
    '# Written by install-mcf-evo-systemd.sh from the credential store. Do not edit:' \
    '# add or remove a wizard-ads-mcf-recipient-<keyId8>.cred file and run the install again.' \
    '[Service]' \
    "LoadCredentialEncrypted=mcf-recipient-$key_one:/etc/credstore.encrypted/wizard-ads-mcf-recipient-$key_one.cred")" ]] \
  || [[ "$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1])), sort_keys=True))' "$root/etc/wizard-ads-mcf/mcf.json")" \
    != '{"OPENSPELL_MCF_DISPATCH_ENABLED": "0", "OPENSPELL_MCF_PREVIEW_ENABLED": "0"}' ]] \
  || [[ "$(stat -c %a "$root/etc/wizard-ads-mcf/mcf.json")" != 644 ]] \
  || [[ "$(cat "$state/enabled") $(cat "$state/active")" != "enabled active" ]]; then
  printf '%s\n' "$run_output" >&2
  echo "fixture: the first install did not place the unit, drop-in and flags-off configuration and start it" >&2
  exit 1
fi
if [[ "$(grep -E '^systemctl (daemon-reload|enable|start|restart)' "$state/calls" | cut -d' ' -f2 | tr '\n' ' ')" \
  != "daemon-reload enable start " ]]; then
  echo "fixture: the first install did not reload, enable and start in order" >&2
  exit 1
fi
first_backup="$(find "$root/etc/wizard-ads-mcf/backups" -mindepth 1 -maxdepth 1 -type d -printf '%f\n')"
if [[ "$(find "$root/etc/wizard-ads-mcf/backups/$first_backup" -type f -printf '%f\n' | LC_ALL=C sort | tr '\n' ' ')" \
  != "config.absent dropin.absent state unit.absent " ]] \
  || [[ "$(cat "$root/etc/wizard-ads-mcf/backups/$first_backup/state")" != $'enabled=absent\nactive=inactive' ]]; then
  echo "fixture: the first install's backup does not record absence and the prior state" >&2
  exit 1
fi

# 8d. Verify passes on a healthy fixture and prints what the runbook reads.
expect_success "verify" "$verifier_fixture" --revision "$revision"
fixture_runs=$((fixture_runs + 1))
for needle in 'pid 4242: Max core file size        0' 'coredump_filter 00000010' 'memory.swap.max: 0' \
  'kernel core_pattern: |/usr/lib/systemd/systemd-coredump' 'heartbeat: age 12 s' 'preview off, dispatch off' \
  'recipient keys loaded by the drop-in: 1' 'DynamicUser: yes' 'ProtectProc: invisible' 'verified at revision'; do
  if [[ "$run_output" != *"$needle"* ]]; then
    printf '%s\n' "$run_output" >&2
    echo "fixture: verify did not print: $needle" >&2
    exit 1
  fi
done
if [[ "$run_output" == *"$database_canary"* ]] || grep -Eq "$mutation_pattern" "$state/calls"; then
  echo "fixture: verify printed the database credential or changed something" >&2
  exit 1
fi

# 8e. Verify refuses each broken property (it changes nothing either way).
write_process 4243 unlimited 61234
expect_refusal "core limit" "pid 4243 may dump core" "$verifier_fixture" --revision "$revision"
write_process 4243 0 1001
expect_refusal "static user" "pid 4243 does not run as a dynamic user" "$verifier_fixture" --revision "$revision"
write_process 4243 0 61234
printf 'LISTEN 0 511 0.0.0.0:8080 0.0.0.0:* users:(("node",pid=4243,fd=21))\n' >>"$state/listeners"
expect_refusal "listener" "pid 4243 listens on a TCP or UDP port" "$verifier_fixture" --revision "$revision"
sed -i '$d' "$state/listeners"
printf 'max\n' >"$cgroup_dir/memory.swap.max"
expect_refusal "swap" "may swap" "$verifier_fixture" --revision "$revision"
printf '0\n' >"$cgroup_dir/memory.swap.max"
sed -i 's/^LimitCORE=0$/LimitCORE=infinity/' "$state/props"
expect_refusal "unit core limit" "LimitCORE is 'infinity'" "$verifier_fixture" --revision "$revision"
sed -i 's/^LimitCORE=infinity$/LimitCORE=0/' "$state/props"
write_heartbeat 600 "$revision"
expect_refusal "stale heartbeat" "age 600 s is over 120 s" "$verifier_fixture" --revision "$revision"
write_heartbeat 12 "$(printf '3%.0s' {1..40})"
expect_refusal "heartbeat revision" "revision differs from the release" "$verifier_fixture" --revision "$revision"
write_heartbeat 12 "$revision" ',"error":"42501"'
expect_refusal "unreadable heartbeat" "code 42501" "$verifier_fixture" --revision "$revision"
if [[ "$run_output" == *"$database_canary"* ]]; then
  echo "fixture: a failed heartbeat probe printed the database credential" >&2
  exit 1
fi
write_heartbeat 12 "$revision"
write_journal '{"event":"mcf_start_refused","reason":"CREDENTIALS_DIRECTORY: no readable recipient key"}'
expect_refusal "refused start" "mcf-main refused to start" "$verifier_fixture" --revision "$revision"
write_journal
printf 'synthetic-encrypted-key\n' >"$root/etc/credstore.encrypted/wizard-ads-mcf-recipient-$key_two.cred"
chmod 0600 "$root/etc/credstore.encrypted/wizard-ads-mcf-recipient-$key_two.cred"
expect_refusal "key not loaded" "rerun the install" "$verifier_fixture" --revision "$revision"

# 8f. A refresh after adding a key: a second backup, both keys, a restart.
sleep 1
expect_success "refresh install" "$installer_fixture" --revision "$revision"
fixture_runs=$((fixture_runs + 1))
if [[ "$(grep -c '^LoadCredentialEncrypted=mcf-recipient-' "$root/etc/systemd/system/wizard-ads-mcf.service.d/recipient-keys.conf")" != 2 ]] \
  || ! grep -q '^systemctl restart wizard-ads-mcf.service$' "$state/calls" \
  || grep -q '^systemctl start ' "$state/calls" \
  || [[ "$(find "$root/etc/wizard-ads-mcf/backups" -mindepth 1 -maxdepth 1 -type d | wc -l)" != 2 ]]; then
  printf '%s\n' "$run_output" >&2
  echo "fixture: the refresh did not load both keys, back up and restart" >&2
  exit 1
fi
expect_success "verify after refresh" "$verifier_fixture" --revision "$revision"
fixture_runs=$((fixture_runs + 1))

# 8g. A key destroyed after the refresh, then a reinstall: the drop-in names only
# the key left in the store (a third backup, whose drop-in named both).
rm "$root/etc/credstore.encrypted/wizard-ads-mcf-recipient-$key_one.cred"
sleep 1
expect_success "reinstall after destroying a key" "$installer_fixture" --revision "$revision"
fixture_runs=$((fixture_runs + 1))
dropin_file="$root/etc/systemd/system/wizard-ads-mcf.service.d/recipient-keys.conf"
if [[ "$(grep -c '^LoadCredentialEncrypted=mcf-recipient-' "$dropin_file")" != 1 ]] || ! grep -q "$key_two" "$dropin_file"; then
  echo "fixture: the reinstall did not drop the destroyed key" >&2
  exit 1
fi

# 8h. Rollback: a dry run changes nothing. Each rollback rebuilds the drop-in from
# the store, so the destroyed key is never named again; an interrupted rollback
# and an unusable configuration refuse before any change; the last rollback
# returns to no unit.
dropin_names_only_key_two() {
  [[ "$(grep -c '^LoadCredentialEncrypted=mcf-recipient-' "$dropin_file")" == 1 ]] \
    && grep -q "$key_two" "$dropin_file" && ! grep -q "$key_one" "$dropin_file"
}
before="$(snapshot)"
expect_success "rollback --dry-run" "$rollback_fixture" --dry-run
if grep -Eq "$mutation_pattern" "$state/calls" || [[ "$(snapshot)" != "$before" ]] \
  || [[ "$run_output" != *"dry run complete"* ]]; then
  printf '%s\n' "$run_output" >&2
  echo "fixture: rollback --dry-run changed something" >&2
  exit 1
fi
fixture_runs=$((fixture_runs + 1))
expect_success "rollback past the destroyed key" "$rollback_fixture"
fixture_runs=$((fixture_runs + 1))
if ! dropin_names_only_key_two \
  || [[ "$(grep -E '^systemctl (stop|disable|daemon-reload|enable|start)' "$state/calls" | cut -d' ' -f2 | tr '\n' ' ')" \
    != "stop disable daemon-reload enable start " ]] \
  || [[ "$(cat "$state/enabled") $(cat "$state/active")" != "enabled active" ]] \
  || [[ "$(find "$root/etc/wizard-ads-mcf/backups" -mindepth 1 -maxdepth 1 -name '*.rolled-back' | wc -l)" != 1 ]]; then
  printf '%s\n' "$run_output" >&2
  echo "fixture: the rollback named a destroyed key or did not restart the unit" >&2
  exit 1
fi
second_backup="$(find "$root/etc/wizard-ads-mcf/backups" -mindepth 1 -maxdepth 1 -type d ! -name '*.rolled-back' \
  -printf '%f\n' | LC_ALL=C sort | tail -n 1)"
: >"$root/etc/wizard-ads-mcf/backups/$second_backup/config.replaced"
expect_refusal "interrupted rollback" "stopped partway" "$rollback_fixture"
rm "$root/etc/wizard-ads-mcf/backups/$second_backup/config.replaced"
cp "$root/etc/wizard-ads-mcf/backups/$second_backup/config" "$test_tmp/config.saved"
printf '{"OPENSPELL_MCF_SCOPE":"bad"}\n' >"$root/etc/wizard-ads-mcf/backups/$second_backup/config"
expect_refusal "rollback to an invalid configuration" "OPENSPELL_MCF_SCOPE must be" "$rollback_fixture"
cp "$test_tmp/config.saved" "$root/etc/wizard-ads-mcf/backups/$second_backup/config"
expect_success "rollback to the refresh" "$rollback_fixture"
fixture_runs=$((fixture_runs + 1))
if ! dropin_names_only_key_two || [[ "$(cat "$state/active")" != active ]]; then
  echo "fixture: the second rollback named a destroyed key or did not restart the unit" >&2
  exit 1
fi
expect_success "rollback to absence" "$rollback_fixture"
fixture_runs=$((fixture_runs + 1))
first_rolled="$root/etc/wizard-ads-mcf/backups/$first_backup.rolled-back"
if [[ -e "$root/etc/systemd/system/wizard-ads-mcf.service" || -e "$root/etc/wizard-ads-mcf/mcf.json" \
  || -e "$dropin_file" ]] \
  || [[ ! -f "$first_rolled/unit.replaced" || ! -f "$first_rolled/config.replaced" || ! -f "$first_rolled/dropin.replaced" ]] \
  || grep -q '^systemctl start' "$state/calls" \
  || [[ "$(cat "$state/enabled") $(cat "$state/active")" != "disabled inactive" ]] \
  || [[ "$(find "$root/etc/credstore.encrypted" -name 'wizard-ads-mcf-recipient-*.cred' | wc -l)" != 1 ]]; then
  printf '%s\n' "$run_output" >&2
  echo "fixture: the last rollback did not return to no unit while keeping the credential file" >&2
  exit 1
fi
expect_refusal "rollback past the first install" "no install backup to roll back to" "$rollback_fixture"

# 8i. A reinstall after the rehearsal works; --remove then takes the unit out in
# one step (its dry run changes nothing), and a later install works again.
sleep 1
expect_success "reinstall after rollback" "$installer_fixture" --revision "$revision"
fixture_runs=$((fixture_runs + 1))
[[ "$(cat "$state/active")" == active ]] || { echo "fixture: reinstall did not start the unit" >&2; exit 1; }
before="$(snapshot)"
expect_success "remove --dry-run" "$rollback_fixture" --remove --dry-run
if grep -Eq "$mutation_pattern" "$state/calls" || [[ "$(snapshot)" != "$before" ]]; then
  echo "fixture: remove --dry-run changed something" >&2
  exit 1
fi
fixture_runs=$((fixture_runs + 1))
sleep 1
expect_success "remove" "$rollback_fixture" --remove
fixture_runs=$((fixture_runs + 1))
removed_dir="$(find "$root/etc/wizard-ads-mcf/backups" -mindepth 1 -maxdepth 1 -type d -name '*-removed')"
if [[ -e "$root/etc/systemd/system/wizard-ads-mcf.service" || -e "$root/etc/wizard-ads-mcf/mcf.json" || -e "$dropin_file" ]] \
  || [[ ! -f "$removed_dir/unit" || ! -f "$removed_dir/dropin" || ! -f "$removed_dir/config" ]] \
  || [[ "$(cat "$removed_dir/state")" != $'enabled=enabled\nactive=active' ]] \
  || [[ "$(cat "$state/enabled") $(cat "$state/active")" != "disabled inactive" ]] \
  || [[ "$(grep -E '^systemctl (stop|disable|daemon-reload)' "$state/calls" | cut -d' ' -f2 | tr '\n' ' ')" \
    != "stop disable daemon-reload " ]]; then
  printf '%s\n' "$run_output" >&2
  echo "fixture: --remove did not stop, disable and move the unit, drop-in and configuration aside" >&2
  exit 1
fi
sleep 1
expect_success "install after remove" "$installer_fixture" --revision "$revision"
fixture_runs=$((fixture_runs + 1))

# 8j. Key generation against its own fixture root, with systemd-creds stubbed
# (encrypt stores the bytes, decrypt returns them): the keyId is the SHA-256 of
# the stored key's SPKI, the public file matches it, nothing is left staged, and a
# credential that does not decrypt to the generated key leaves nothing behind.
genroot="$test_tmp/genroot"
install -d -m 0755 "$genroot/etc/credstore.encrypted" "$genroot/run/lock"
cat >"$stubs/systemd-creds" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  encrypt)
    [[ " $* " == *" --with-key=host+tpm2 "* ]] || exit 64
    cat >"${!#}" ;;
  decrypt)
    # A different, valid key: the generator must compare key ids, not only decode.
    if [[ -e "$MCF_FIXTURE_STATE/corrupt-decrypt" ]]; then
      openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -outform DER
    else
      cat "${@: -2:1}"
    fi ;;
  *) exit 64 ;;
esac
SH
chmod 0755 "$stubs/systemd-creds"
gen_output="$(cd "$fixture_scripts" && MCF_EVO_ROOT="$genroot" bash generate-mcf-recipient-key-evo.sh 2>&1)" || {
  printf '%s\n' "$gen_output" >&2; echo "fixture: key generation failed" >&2; exit 1; }
fixture_runs=$((fixture_runs + 1))
gen_key_id="$(sed -n 's/^keyId: \([0-9a-f]\{64\}\)$/\1/p' <<<"$gen_output")"
gen_key8="${gen_key_id:0:8}"
gen_cred="$genroot/etc/credstore.encrypted/wizard-ads-mcf-recipient-$gen_key8.cred"
gen_public_dir="$genroot/etc/wizard-ads-mcf"
gen_public="$gen_public_dir/recipient-$gen_key8.public.json"
if [[ -z "$gen_key_id" || ! -f "$gen_cred" || "$(stat -c %a "$gen_cred")" != 600 \
  || "$(stat -c %a "$gen_public")" != 644 \
  || "$(openssl pkey -inform DER -in "$gen_cred" -pubout -outform DER | sha256sum | cut -c1-64)" != "$gen_key_id" \
  || -n "$(find "$genroot/etc/credstore.encrypted" -name '*.staged')" ]] \
  || ! python3 - "$gen_public" "$gen_key_id" <<'PY'
import base64, hashlib, json, sys
value = json.load(open(sys.argv[1]))
jwk = value["jwk"]
point = b"\x04" + base64.urlsafe_b64decode(jwk["x"] + "==") + base64.urlsafe_b64decode(jwk["y"] + "==")
spki = bytes.fromhex("3059301306072a8648ce3d020106082a8648ce3d030107034200") + point
if sorted(value) != ["jwk", "keyId"] or sorted(jwk) != ["crv", "kty", "x", "y"] or value["keyId"] != sys.argv[2] \
        or hashlib.sha256(spki).hexdigest() != sys.argv[2]:
    sys.exit(1)
PY
then
  printf '%s\n' "$gen_output" >&2
  echo "fixture: the generated key, its keyId and its public value do not agree" >&2
  exit 1
fi
if [[ "$gen_output" == *"PRIVATE KEY"* ]]; then
  echo "fixture: key generation printed key material" >&2
  exit 1
fi
: >"$state/corrupt-decrypt"
if gen_output="$(cd "$fixture_scripts" && MCF_EVO_ROOT="$genroot" bash generate-mcf-recipient-key-evo.sh 2>&1)" \
  || [[ "$gen_output" != *"does not decrypt to the generated key"* ]] \
  || [[ "$(find "$genroot/etc/credstore.encrypted" -type f | wc -l)" != 1 ]] \
  || [[ "$(find "$genroot/etc/wizard-ads-mcf" -type f | wc -l)" != 1 ]]; then
  printf '%s\n' "$gen_output" >&2
  echo "fixture: a credential that does not decrypt to the key was kept or a file was left" >&2
  exit 1
fi
rm "$state/corrupt-decrypt"
refusals=$((refusals + 1))

echo "Evo MCF deployment invariants passed ($ran_tests mcf runtime tests, $hardening_count hardening lines, $fixture_runs fixture runs, $refusals refusals)"
