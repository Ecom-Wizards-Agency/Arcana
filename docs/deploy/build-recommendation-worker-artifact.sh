#!/usr/bin/env bash
# Build and verify an artifact without privileges, credentials or service changes.
# Installation separately requires a clean exact approved origin/main revision.
set -euo pipefail

verify_recommendation_worker_artifact_content() {
  local target="$1" source_root="$2" private_locator_pattern
  private_locator_pattern='op:/''/'
  if rg -I -q -F "$source_root" "$target" \
    || rg -I -q "/(home|Users)/|$private_locator_pattern" "$target" \
    || rg -I -q '(AMAZON_|LWA_|SP_API_|ADS_CLIENT_|SELLING_PARTNER_)' "$target"; then
    echo 'refusing staging: artifact contains a checkout, credential locator, or provider setting' >&2
    return 1
  fi
}

build_recommendation_worker_artifact() (
  # New generated files must already satisfy the staging check, independent of
  # the caller's group-writable umask. Installed modes are verified again below.
  umask 022
  [[ $# == 4 && "$1" == --revision && "$2" =~ ^[0-9a-f]{40}$ && "$3" == --output ]] || {
    echo 'usage: build-recommendation-worker-artifact.sh --revision <full-git-object-id> --output <new-directory>' >&2
    exit 2
  }
  expected_revision="$2"
  destination="$4"
  for command in node git readlink mktemp install systemd-analyze rg find grep sort xargs sha256sum chmod mv rm; do
    command -v "$command" >/dev/null || {
      echo "artifact build tool unavailable: $command" >&2; exit 1;
    }
  done
  [[ "$destination" == /* && ! -e "$destination" && ! -L "$destination" ]] || {
    echo 'artifact output must be a new absolute directory' >&2; exit 1;
  }
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  repo_root="$(git -C "$script_dir" rev-parse --show-toplevel)"
  node_runtime="$(command -v node)"
  (( $("$node_runtime" -p 'Number(process.versions.node.split(".")[0])') >= 22 )) || {
    echo 'artifact build requires Node 22 or newer' >&2; exit 1;
  }
  # shellcheck source=docs/deploy/recommendation-worker-evo-systemd-lib.sh
  source "$script_dir/recommendation-worker-evo-systemd-lib.sh"
  recommendation_worker_script_dir="$script_dir"
  build_root="$(mktemp -d /tmp/openspell-recommendation-artifact.XXXXXX)"
  trap 'rm -rf -- "$build_root"' EXIT
  tsx_source="$(readlink -f "$repo_root/node_modules/tsx")"
  esbuild_source="$(readlink -f "$(dirname "$tsx_source")/esbuild")"
  esbuild_bin="$esbuild_source/bin/esbuild"
  [[ -x "$esbuild_bin" ]] || {
    echo 'refusing staging: pinned bundler is unavailable' >&2; exit 1;
  }
  release_stage="$build_root/release"
  install -d -m 0755 "$release_stage/bin" "$release_stage/systemd"

  bundle_args=(
    --bundle --platform=node --format=esm --target=node22
    "--alias:@wizard-ads/db/recommendation-worker=$repo_root/packages/db/src/recommendation-worker.ts"
    "--alias:@wizard-ads/db/worker=$repo_root/packages/db/src/worker.ts"
    "--alias:@wizard-ads/core=$repo_root/packages/core/src/index.ts"
    "--alias:@wizard-ads/db=$repo_root/packages/db/src/index.ts"
    "--alias:@wizard-ads/shared=$repo_root/packages/shared/src/index.ts"
    "--alias:@wizard-ads/strategy=$repo_root/packages/strategy/src/index.ts"
  )
  "$esbuild_bin" "$repo_root/apps/worker/src/recommendation-lane/main.ts" \
    "${bundle_args[@]}" \
    "--outfile=$release_stage/bin/openspell-recommendation-worker-runtime.mjs" \
    "--metafile=$build_root/runtime-meta.json" >"$build_root/runtime-bundle.log" 2>&1
  "$esbuild_bin" "$script_dir/openspell-recommendation-worker-authority.mjs" \
    "${bundle_args[@]}" \
    "--outfile=$release_stage/bin/openspell-recommendation-worker-authority.mjs" \
    "--metafile=$build_root/authority-meta.json" >"$build_root/authority-bundle.log" 2>&1

  "$node_runtime" - "$repo_root" "$build_root/runtime-meta.json" \
    "$build_root/authority-meta.json" "$release_stage/RUNTIME_INPUTS" <<'NODE'
  const fs = require('node:fs');
  const path = require('node:path');
  const [root, ...files] = process.argv.slice(2);
  const output = files.pop();
  const inputs = new Set([
    'docs/deploy/build-recommendation-worker-artifact.sh',
    'docs/deploy/install-recommendation-worker-evo-systemd.sh',
    'docs/deploy/install-recommendation-database-ca.sh',
  ]);
  for (const file of files) {
    const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Object.keys(meta.outputs ?? {}).length !== 1) process.exit(1);
    for (const input of Object.keys(meta.inputs ?? {})) {
      const absolute = path.resolve(root, input);
      const relative = path.relative(root, absolute).replaceAll(path.sep, '/');
      if (relative === '..' || relative.startsWith('../')) process.exit(1);
      inputs.add(relative);
    }
  }
  const forbidden = /(?:^|\/)(?:packages\/(?:ads-api|sp-api|keepa-api|mrp-api|datadive-api)|apps\/worker\/src\/(?:ads-api|store|worker|schedules)\.ts|tools\/recommendation-authority\/src\/(?:entry|broker|database)\.ts)(?:\/|$)/u;
  const providerStore = /node_modules\/\.pnpm\/(?:@aws-sdk|@smithy|@wizard-ads\+(?:ads-api|sp-api|keepa-api|mrp-api|datadive-api))/u;
  if ([...inputs].some((input) => forbidden.test(input) || providerStore.test(input))) process.exit(1);
  fs.writeFileSync(output, `${[...inputs].sort().join('\n')}\n`, { mode: 0o644 });
NODE

  printf '%s\n' "$expected_revision" >"$release_stage/REVISION"
  claim_protocol_key=WORKER_CLAIM
  claim_protocol_key+=_PROTOCOL
  deployment_role_key=WORKER_DEPLOYMENT
  deployment_role_key+=_ROLE
  for armed in 0 1; do
    name=standby
    [[ "$armed" == 1 ]] && name=armed
    printf '%s\n' \
      "OPENSPELL_WORKER_REVISION=$expected_revision" \
      'PORT=3002' \
      "WORKER_CLAIM_ARMED=$armed" \
      'WORKER_CLAIM_BATCH_SIZE=1' \
      "$claim_protocol_key=recommendation-fenced-v1" \
      "$deployment_role_key=evo-recommendation-lane" \
      'WORKER_ID=evo-recommendation-worker' \
      'WORKER_JOB_TYPES=recommendations.run' \
      'WORKER_MAX_CONCURRENT_JOBS=1' \
      'WORKER_POLL_INTERVAL_MS=1000' \
      'WORKER_SHUTDOWN_DRAIN_MS=25000' \
      >"$release_stage/public-$name.conf"
  done
  install -m 0644 "$script_dir/openspell-recommendation-worker-contract.mjs" \
    "$release_stage/bin/openspell-recommendation-worker-contract.mjs"
  install -m 0644 "$script_dir/openspell-recommendation-worker-launch.mjs" \
    "$release_stage/bin/openspell-recommendation-worker-launch.mjs"
  install -m 0644 "$script_dir/openspell-recommendation-worker-health.mjs" \
    "$release_stage/bin/openspell-recommendation-worker-health.mjs"
  install -m 0644 "$script_dir/openspell-recommendation-worker-standby.service" \
    "$release_stage/systemd/openspell-recommendation-worker-standby.service"
  install -m 0644 "$script_dir/openspell-recommendation-worker-armed.service" \
    "$release_stage/systemd/openspell-recommendation-worker-armed.service"
  systemd-analyze verify \
    "$release_stage/systemd/openspell-recommendation-worker-standby.service" \
    "$release_stage/systemd/openspell-recommendation-worker-armed.service" \
    >"$build_root/systemd-verify.log" 2>&1 || {
    echo 'refusing staging: recommendation worker unit verification failed' >&2
    exit 1
  }

  verify_recommendation_worker_artifact_content "$release_stage" "$repo_root"
  if find "$release_stage" \( -type f -o -type d \) -perm /022 -print -quit | grep -q .; then
    echo 'refusing staging: artifact contains writable content' >&2
    exit 1
  fi

  directory_count="$(find "$release_stage" -type d | wc -l)"
  file_count="$(find "$release_stage" -type f | wc -l)"
  link_count="$(find "$release_stage" -type l | wc -l)"
  printf 'directories=%s\nfiles=%s\nsymlinks=%s\n' \
    "$directory_count" "$((file_count + 2))" "$link_count" >"$release_stage/ARTIFACT_COUNTS"
  (cd "$release_stage" && find . -type f -print0 \
    | LC_ALL=C sort -z | xargs -0 sha256sum >"$build_root/ARTIFACT_SHA256")
  mv "$build_root/ARTIFACT_SHA256" "$release_stage/ARTIFACT_SHA256"
  normalize_recommendation_worker_artifact_modes "$release_stage"

  verify_recommendation_worker_artifact "$release_stage" "$expected_revision" || {
    echo 'refusing staging: immutable artifact verification failed' >&2; exit 1;
  }
  mv -- "$release_stage" "$destination"
)

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  build_recommendation_worker_artifact "$@"
fi
