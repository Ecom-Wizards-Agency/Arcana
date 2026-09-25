#!/usr/bin/env bash
# Build the Evo general worker release (WP-326) without privileges, credentials
# or service changes. Run it from a clean checkout of the approved revision with
# its locked dependencies installed; installation is a separate, attended step
# (see the host upgrade runbook).
#
# Release layout:
#   REVISION, ARTIFACT_SHA256, ARTIFACT_LINKS, credential_runtime.py,
#   wizard-ads-worker.TEMPLATE.json, systemd/*.service,
#   app/ (pnpm deploy of @wizard-ads/worker with its pinned tsx runtime)
set -euo pipefail

# Stage a normalized release of the checkout at repo_root into a new directory.
stage_evo_general_worker_release() {
  local repo_root="$1" revision="$2" stage="$3" log_dir="$4"
  local script_dir tsx_source esbuild_source platform_link platform_source platform_name
  local private_locator_pattern
  script_dir="$repo_root/docs/deploy"
  [[ "$revision" =~ ^[0-9a-f]{40}$ ]] || {
    echo 'refusing staging: revision must be a full lowercase Git object id' >&2; return 1;
  }
  [[ "$stage" == /* && ! -e "$stage" && ! -L "$stage" ]] || {
    echo 'refusing staging: stage must be a new absolute directory' >&2; return 1;
  }
  install -d -m 0755 "$stage" "$stage/systemd"
  if ! pnpm --dir "$repo_root" --config.inject-workspace-packages=true \
    --filter @wizard-ads/worker deploy "$stage/app" >"$log_dir/package.log" 2>&1; then
    echo 'refusing staging: general worker packaging failed' >&2
    return 1
  fi

  tsx_source="$(readlink -f "$repo_root/node_modules/tsx" 2>/dev/null || true)"
  esbuild_source="$(readlink -f "$(dirname "$tsx_source")/esbuild" 2>/dev/null || true)"
  [[ -f "$tsx_source/package.json" && -f "$esbuild_source/package.json" ]] || {
    echo 'refusing staging: pinned TypeScript runtime is incomplete' >&2; return 1;
  }
  mapfile -t esbuild_platforms < <(
    find "$(dirname "$esbuild_source")/@esbuild" -mindepth 1 -maxdepth 1 \
      \( -type d -o -type l \) -printf '%p\n' 2>/dev/null
  )
  ((${#esbuild_platforms[@]} == 1)) || {
    echo 'refusing staging: expected one host-specific esbuild runtime' >&2; return 1;
  }
  platform_link="${esbuild_platforms[0]}"
  platform_source="$(readlink -f "$platform_link")"
  platform_name="$(basename "$platform_link")"
  [[ -f "$platform_source/package.json" && "$platform_name" =~ ^[a-z0-9_-]+$ ]] || {
    echo 'refusing staging: host-specific esbuild runtime is invalid' >&2; return 1;
  }
  install -d -m 0755 "$stage/app/node_modules/tsx" "$stage/app/node_modules/esbuild" \
    "$stage/app/node_modules/@esbuild/$platform_name"
  rsync -aL --delete "$tsx_source/" "$stage/app/node_modules/tsx/"
  rsync -aL --delete "$esbuild_source/" "$stage/app/node_modules/esbuild/"
  rsync -aL --delete "$platform_source/" "$stage/app/node_modules/@esbuild/$platform_name/"

  printf '%s\n' "$revision" >"$stage/REVISION"
  install -m 0755 "$script_dir/wizard-ads-credential-runtime.py" "$stage/credential_runtime.py"
  install -m 0644 "$script_dir/wizard-ads-worker.TEMPLATE.json" \
    "$stage/wizard-ads-worker.TEMPLATE.json"
  install -m 0644 "$script_dir/wizard-ads-worker.service" "$stage/systemd/wizard-ads-worker.service"
  install -m 0644 "$script_dir/wizard-ads-spapi-connections.service" \
    "$stage/systemd/wizard-ads-spapi-connections.service"

  if ! node "$script_dir/normalize-evo-general-worker-artifact.mjs" "$stage" \
    >"$log_dir/normalize.log" 2>&1; then
    echo 'refusing staging: general worker release normalization failed' >&2
    return 1
  fi

  private_locator_pattern='op:/''/'
  if rg --hidden --no-ignore -I -q -F "$repo_root" "$stage" \
    || rg --hidden --no-ignore -I -q "/(home|Users)/|$private_locator_pattern" "$stage" \
    || find "$stage" -path '*home+*' -print -quit | grep -q .; then
    echo 'refusing staging: release retains a checkout or private locator' >&2
    return 1
  fi
  if find "$stage" \( -name .git -o -name _local -o -name '*.env' -o -name '*.cred' \) \
    -print -quit | grep -q .; then
    echo 'refusing staging: release contains repository, environment or credential files' >&2
    return 1
  fi
  mapfile -d '' -t workspace_source_roots < <(
    find "$stage/app/node_modules/.pnpm" -type d -path '*/node_modules/@wizard-ads/*/src' -print0
  )
  if ((${#workspace_source_roots[@]} == 0)) || rg --hidden --no-ignore -I -q --pcre2 \
    '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}' \
    "$stage/app/src" "${workspace_source_roots[@]}"; then
    echo 'refusing staging: release sources contain a profile-shaped identifier' >&2
    return 1
  fi
  if find "$stage" \( -type f -o -type d \) -perm /022 -print -quit | grep -q .; then
    echo 'refusing staging: release contains writable content' >&2
    return 1
  fi
  (cd "$stage" && sha256sum --quiet -c ARTIFACT_SHA256 \
    && find . -type l -printf '%P\t%l\n' | LC_ALL=C sort | cmp -s - ARTIFACT_LINKS) || {
    echo 'refusing staging: release checksums do not verify' >&2; return 1;
  }
}

build_evo_general_worker_artifact() (
  umask 022
  [[ $# == 4 && "$1" == --revision && "$2" =~ ^[0-9a-f]{40}$ && "$3" == --output ]] || {
    echo 'usage: build-evo-general-worker-artifact.sh --revision <full-git-object-id> --output <new-directory>' >&2
    exit 2
  }
  expected_revision="$2"
  destination="$4"
  for command in node pnpm git readlink mktemp install rsync rg find grep sort sha256sum mv; do
    command -v "$command" >/dev/null || {
      echo "artifact build tool unavailable: $command" >&2; exit 1;
    }
  done
  (( $(node -p 'Number(process.versions.node.split(".")[0])') >= 22 )) || {
    echo 'artifact build requires Node 22 or newer' >&2; exit 1;
  }
  [[ "$destination" == /* && ! -e "$destination" && ! -L "$destination" ]] || {
    echo 'artifact output must be a new absolute directory' >&2; exit 1;
  }
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  repo_root="$(git -C "$script_dir" rev-parse --show-toplevel)"
  [[ "$(git -C "$repo_root" rev-parse HEAD)" == "$expected_revision" ]] || {
    echo 'refusing build: checkout does not match the approved revision' >&2; exit 1;
  }
  [[ -z "$(git -C "$repo_root" status --porcelain --untracked-files=normal)" ]] || {
    echo 'refusing build: checkout is not clean' >&2; exit 1;
  }
  build_root="$(mktemp -d)"
  trap 'rm -rf -- "$build_root"' EXIT
  pnpm --dir "$repo_root" install --frozen-lockfile >"$build_root/install.log" 2>&1 || {
    echo 'refusing build: locked dependency install failed' >&2; exit 1;
  }
  bash "$script_dir/test-evo-general-worker-deployment.sh" >"$build_root/proof.log" 2>&1 || {
    cat "$build_root/proof.log" >&2
    echo 'refusing build: static deployment proof failed' >&2; exit 1;
  }
  [[ -z "$(git -C "$repo_root" status --porcelain --untracked-files=normal)" ]] || {
    echo 'refusing build: install or proof changed the checkout' >&2; exit 1;
  }
  stage_evo_general_worker_release "$repo_root" "$expected_revision" \
    "$build_root/release" "$build_root"
  mv -- "$build_root/release" "$destination"
  echo "Evo general worker release built at revision $expected_revision"
)

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  build_evo_general_worker_artifact "$@"
fi
