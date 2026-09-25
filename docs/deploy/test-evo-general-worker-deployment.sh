#!/usr/bin/env bash
# Static deployment proof for the Evo general worker release (WP-326).
# Needs no privileges, credentials, host configuration or database.
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(git -C "$script_dir" rev-parse --show-toplevel)"
runtime="$script_dir/wizard-ads-credential-runtime.py"
runtime_test="$script_dir/test-evo-general-worker-runtime.py"
worker_unit="$script_dir/wizard-ads-worker.service"
spapi_unit="$script_dir/wizard-ads-spapi-connections.service"
template="$script_dir/wizard-ads-worker.TEMPLATE.json"
builder="$script_dir/build-evo-general-worker-artifact.sh"
normalizer="$script_dir/normalize-evo-general-worker-artifact.mjs"
release_path=/usr/local/lib/wizard-ads-runtime/worker-current

for script in "$builder" "$0"; do
  bash -n "$script"
done
node --check "$normalizer"
python3 -B -c 'import ast, sys
for path in sys.argv[1:]:
    ast.parse(open(path, encoding="utf-8").read(), path)' "$runtime" "$runtime_test"

# 1. Credential mapping tests: every declared test must run and pass.
declared_tests="$(grep -c '^    def test_' "$runtime_test")"
test_output="$(python3 -B "$runtime_test" 2>&1)" || {
  printf '%s\n' "$test_output" >&2
  echo "credential runtime tests failed" >&2
  exit 1
}
ran_tests="$(printf '%s\n' "$test_output" | sed -n 's/^Ran \([0-9][0-9]*\) tests\{0,1\} in .*/\1/p')"
if [[ "$ran_tests" != "$declared_tests" || "$declared_tests" -lt 1 ]] \
  || ! printf '%s\n' "$test_output" | grep -qx 'OK'; then
  echo "credential runtime tests ran $ran_tests of $declared_tests declared" >&2
  exit 1
fi

# 2. Both units keep the host unit's lines exactly. Only comments, Description=,
# ExecStart= and LoadCredentialEncrypted= may differ, so no directive can be
# added, repeated, reordered or overridden (a later ProtectHome=no, say).
require_line() {
  local file="$1" line="$2"
  if ! grep -Fqx -- "$line" "$file"; then
    echo "missing invariant in $(basename "$file"): $line" >&2
    exit 1
  fi
}
host_unit_lines='[Unit]
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=30min
StartLimitBurst=6
[Service]
Type=simple
User=wizard-ads-runtime
Group=wizard-ads-runtime
StateDirectory=wizard-ads
StateDirectoryMode=0750
Restart=on-failure
RestartSec=30s
RestartSteps=6
RestartMaxDelaySec=15min
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
SystemCallArchitectures=native
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
[Install]
WantedBy=multi-user.target'
for unit in "$worker_unit" "$spapi_unit"; do
  shape="$(grep -v -e '^#' -e '^Description=' -e '^ExecStart=' \
    -e '^LoadCredentialEncrypted=' -e '^[[:space:]]*$' "$unit")"
  if [[ "$shape" != "$host_unit_lines" ]]; then
    echo "$(basename "$unit") differs from the host unit outside its command and credentials" >&2
    diff <(printf '%s\n' "$host_unit_lines") <(printf '%s\n' "$shape") >&2 || true
    exit 1
  fi
  if [[ "$(grep -c '^Description=' "$unit")" != 1 || "$(grep -c '^ExecStart=' "$unit")" != 1 ]]; then
    echo "$(basename "$unit") must have exactly one Description= and one ExecStart=" >&2
    exit 1
  fi
done
require_line "$worker_unit" "ExecStart=$release_path/credential_runtime.py worker"
require_line "$spapi_unit" "ExecStart=$release_path/credential_runtime.py spapi-connections"

# 3. Unit credential names equal the runtime mapping, each from its own file.
expected_credentials="$(python3 -B - "$runtime" <<'PY'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("credential_runtime", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
for name in sorted(module.WORKER_CREDENTIALS):
    print(name)
PY
)"
if [[ "$(printf '%s\n' "$expected_credentials" | wc -l)" != 3 ]]; then
  echo "runtime credential mapping does not declare exactly three credentials" >&2
  exit 1
fi
for unit in "$worker_unit" "$spapi_unit"; do
  actual="$(awk -F '[=:]' '$1 == "LoadCredentialEncrypted" { print $2 }' "$unit" | LC_ALL=C sort)"
  if [[ "$actual" != "$(printf '%s\n' "$expected_credentials" | LC_ALL=C sort)" ]]; then
    echo "$(basename "$unit") credential names do not match the runtime mapping" >&2
    exit 1
  fi
  while IFS= read -r name; do
    require_line "$unit" \
      "LoadCredentialEncrypted=$name:/etc/credstore.encrypted/wizard-ads-$name.cred"
  done <<<"$expected_credentials"
done

# 4. The public configuration template holds no secret and only allowed keys.
python3 -B - "$runtime" "$template" <<'PY'
import importlib.util, json, re, sys
spec = importlib.util.spec_from_file_location("credential_runtime", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
config = json.load(open(sys.argv[2], encoding="utf-8"))
def fail(message):
    sys.exit(f"worker.json template: {message}")
if not isinstance(config, dict) or not all(isinstance(v, str) for v in config.values()):
    fail("must be an object of strings")
if set(config) - module.WORKER_ENV_KEYS:
    fail("contains keys outside the runtime allowlist")
if set(config) & set(module.WORKER_CREDENTIALS.values()):
    fail("names a credential variable")
if config.get("WORKER_ID") != "<worker-id>":
    fail("WORKER_ID must stay a placeholder")
if not re.fullmatch(r"<[^<>]+>", config.get("SP_API_APPLICATION_ID", "")):
    fail("SP_API_APPLICATION_ID must stay a placeholder")
if config.get("WORKER_JOB_TYPES") != "keepa.sync,rank.sync,economics.sync,sqp.categorize,recommendations.run":
    fail("the general worker job types changed")
if config.get(module.SPAPI_GATE) != "1":
    fail("the general worker must own the SP-API connection loop")
secret_shapes = [r"postgres(ql)?://", r"amzn1\.oa2-cs", r"amzn1\.application-oa2-client\.",
                 "op" + r":/" + "/", r"/(home|Users)/", r"[A-Za-z0-9+=_-]{24,}"]
for value in config.values():
    if any(re.search(shape, value) for shape in secret_shapes):
        fail("contains a secret-shaped or host-identifying value")
PY

# 5. The build pins the release to its checkout revision.
for needle in \
  'printf '"'"'%s\n'"'"' "$revision" >"$stage/REVISION"' \
  '[[ "$(git -C "$repo_root" rev-parse HEAD)" == "$expected_revision" ]]' \
  'git -C "$repo_root" status --porcelain --untracked-files=normal' \
  'install -m 0755 "$script_dir/wizard-ads-credential-runtime.py" "$stage/credential_runtime.py"' \
  'normalize-evo-general-worker-artifact.mjs" "$stage"'; do
  if ! grep -Fq -- "$needle" "$builder"; then
    echo "build invariant is missing: $needle" >&2
    exit 1
  fi
done
if grep -En 'sudo|systemctl|/etc/credstore|systemd-creds' "$builder"; then
  echo "the unprivileged build can reach a service, credential or privileged command" >&2
  exit 1
fi

# 6. Public-repository and lane hygiene of the deployment directory.
write_token=SP_
write_token+=WRITE
if rg -n -F -- "$write_token" "$script_dir"; then
  echo "docs/deploy names the SP write surface" >&2
  exit 1
fi
private_locator_pattern='op:/''/'
if rg -n -- "/home/|/Users/|$private_locator_pattern" \
  "$runtime" "$runtime_test" "$worker_unit" "$spapi_unit" "$template" "$builder" "$normalizer"; then
  echo "deployment files contain a home path or private locator" >&2
  exit 1
fi

# 7. Units are valid systemd definitions (identity and command stubbed).
test_tmp="$(mktemp -d /tmp/wizard-ads-evo-worker-test.XXXXXX)"
cleanup() {
  case "$test_tmp" in
    /tmp/wizard-ads-evo-worker-test.*) find "$test_tmp" -depth -delete 2>/dev/null || true ;;
  esac
}
trap cleanup EXIT
install -d -m 0700 "$test_tmp/systemd"
for unit in "$worker_unit" "$spapi_unit"; do
  sed -e 's#^ExecStart=.*#ExecStart=/bin/true#' -e '/^User=/d' -e '/^Group=/d' \
    "$unit" >"$test_tmp/systemd/$(basename "$unit")"
done
systemd-analyze verify "$test_tmp/systemd/wizard-ads-worker.service" \
  "$test_tmp/systemd/wizard-ads-spapi-connections.service"

# 8. A staged release carries its revision into the worker environment.
# shellcheck source=docs/deploy/build-evo-general-worker-artifact.sh
source "$builder"
fixture_revision=0000000000000000000000000000000000000001
stage="$test_tmp/release"
stage_evo_general_worker_release "$repo_root" "$fixture_revision" "$stage" "$test_tmp"
if [[ "$(<"$stage/REVISION")" != "$fixture_revision" ]] \
  || ! cmp -s "$runtime" "$stage/credential_runtime.py" \
  || ! cmp -s "$worker_unit" "$stage/systemd/wizard-ads-worker.service" \
  || ! cmp -s "$spapi_unit" "$stage/systemd/wizard-ads-spapi-connections.service" \
  || ! cmp -s "$template" "$stage/wizard-ads-worker.TEMPLATE.json" \
  || [[ ! -x "$stage/credential_runtime.py" ]]; then
  echo "staged release does not carry its revision, runtime, units and template" >&2
  exit 1
fi
checksummed="$(wc -l <"$stage/ARTIFACT_SHA256")"
release_files="$(find "$stage" -type f ! -name ARTIFACT_SHA256 | wc -l)"
if [[ "$checksummed" != "$release_files" ]]; then
  echo "release checksums cover $checksummed of $release_files files" >&2
  exit 1
fi
(cd "$stage" && sha256sum --quiet -c ARTIFACT_SHA256)
if ! grep -q '  ./ARTIFACT_LINKS$' "$stage/ARTIFACT_SHA256" \
  || [[ "$(wc -l <"$stage/ARTIFACT_LINKS")" != "$(find "$stage" -type l | wc -l)" ]]; then
  echo "release link manifest is missing, unchecksummed or incomplete" >&2
  exit 1
fi
retarget="$(find "$stage/app/node_modules" -type l -print -quit)"
[[ -n "$retarget" ]] || { echo "release has no link to test the manifest with" >&2; exit 1; }
original_target="$(readlink "$retarget")"
ln -sfn "$original_target/.." "$retarget"
if (cd "$stage" && find . -type l -printf '%P\t%l\n' | LC_ALL=C sort | cmp -s - ARTIFACT_LINKS); then
  echo "release link manifest accepted a retargeted link" >&2
  exit 1
fi
ln -sfn "$original_target" "$retarget"
(cd "$stage" && find . -type l -printf '%P\t%l\n' | LC_ALL=C sort | cmp -s - ARTIFACT_LINKS)
printf '\n' >>"$stage/wizard-ads-worker.TEMPLATE.json"
if (cd "$stage" && sha256sum --quiet -c ARTIFACT_SHA256 >/dev/null 2>&1); then
  echo "release checksums accepted a modified file" >&2
  exit 1
fi
install -d -m 0700 "$test_tmp/credentials"
printf '%s\n' 'postgres://synthetic:fixture@127.0.0.1:5432/postgres' >"$test_tmp/credentials/database-url"
printf 'synthetic-lwa-client-id\n' >"$test_tmp/credentials/spapi-lwa-client-id"
printf 'synthetic-lwa-client-value\n' >"$test_tmp/credentials/spapi-lwa-client-secret-value"
python3 -B - "$stage/credential_runtime.py" "$template" "$test_tmp" "$fixture_revision" <<'PY'
import importlib.util, io, json, os, sys
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock
path, template, tmp, revision = sys.argv[1:]
spec = importlib.util.spec_from_file_location("staged_runtime", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
config = json.load(open(template, encoding="utf-8"))
config.update({"WORKER_ID": "fixture-worker", "SP_API_APPLICATION_ID": "fixture-application",
               "SP_API_OAUTH_REGION": "NA",
               "SP_API_OAUTH_ALLOWED_REDIRECT_URIS": "https://example.test/api/amazon/spapi/oauth/callback"})
Path(tmp, "worker.json").write_text(json.dumps(config))
captured = {}
def execve(node, argv, env):
    captured.update(node=node, argv=argv, env=env)
    raise SystemExit(0)
os.environ["CREDENTIALS_DIRECTORY"] = str(Path(tmp, "credentials"))
with mock.patch.object(module, "WORKER_CONFIG", Path(tmp, "worker.json")), \
        mock.patch.object(module.os, "execve", execve), redirect_stdout(io.StringIO()):
    try:
        module.run_worker()
    except SystemExit:
        pass
release = Path(path).resolve().parent
if captured.get("node") != "/usr/local/bin/node" \
        or captured["argv"][1:] != [str(release / "app/node_modules/tsx/dist/cli.mjs"), "src/main.ts"] \
        or captured["env"].get("OPENSPELL_WORKER_REVISION") != revision \
        or captured["env"].get("SP_API_LWA_CLIENT_ID") != "synthetic-lwa-client-id" \
        or not Path(captured["argv"][1]).is_file() or not Path(release, "app/src/main.ts").is_file():
    sys.exit("staged runtime did not launch its own release at its recorded revision")
PY
# Every import reachable from both entry points resolves inside the release,
# without executing main.ts (which connects at import).
(cd "$stage/app" && node - <<'NODE'
const esbuild = require('./node_modules/esbuild');
const result = esbuild.buildSync({
  entryPoints: ['src/main.ts', 'src/spapi-connections-cli.ts'],
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  outdir: 'unused', write: false, metafile: true, logLevel: 'silent',
});
const inputs = Object.keys(result.metafile.inputs);
const outside = inputs.filter((input) => input.startsWith('..') || input.startsWith('/'));
if (outside.length > 0 || result.outputFiles.length < 2
  || !inputs.some((input) => input.includes('@wizard-ads+sp-api'))
  || !inputs.some((input) => input.includes('@aws-sdk+client-sqs'))) {
  console.error(`release import graph is incomplete or escapes app/ (${outside.length} outside)`);
  process.exit(1);
}
console.log(`resolved ${inputs.length} modules from main.ts and spapi-connections-cli.ts`);
NODE
) >"$test_tmp/import-graph.log"
cat "$test_tmp/import-graph.log"

echo "Evo general worker deployment invariants passed ($ran_tests runtime tests, $checksummed release files checksummed)"
