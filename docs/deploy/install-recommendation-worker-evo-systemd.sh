#!/usr/bin/env bash
set -euo pipefail

expected_revision=
while (($# > 0)); do
  case "$1" in
    --revision) expected_revision="${2:-}"; shift 2 ;;
    *) echo "usage: $0 --revision <full-git-object-id>" >&2; exit 2 ;;
  esac
done
if [[ ! "$expected_revision" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'refusing staging: revision must be a full lowercase Git object id' >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=docs/deploy/recommendation-worker-evo-systemd-lib.sh
source "$script_dir/recommendation-worker-evo-systemd-lib.sh"
recommendation_worker_script_dir="$script_dir"
build_root=
incoming_release=
cleanup() {
  case "$build_root" in
    /tmp/openspell-recommendation-worker-install.*)
      find "$build_root" -depth -delete 2>/dev/null || true ;;
  esac
  case "$incoming_release" in
    /opt/openspell-recommendation-worker/releases/.incoming-*)
      sudo find "$incoming_release" -xdev -depth -delete 2>/dev/null || true ;;
  esac
  release_recommendation_worker_deployment_lock
}
trap cleanup EXIT

repo_root="$(git -C "$script_dir" rev-parse --show-toplevel)"
[[ "$(git -C "$repo_root" rev-parse HEAD)" == "$expected_revision" ]] || {
  echo 'refusing staging: checkout does not match approved revision' >&2; exit 1;
}
[[ "$(git -C "$repo_root" rev-parse refs/remotes/origin/main)" == "$expected_revision" ]] || {
  echo 'refusing staging: approved revision is not current origin/main' >&2; exit 1;
}
[[ -z "$(git -C "$repo_root" status --porcelain --untracked-files=normal)" ]] || {
  echo 'refusing staging: checkout is not clean' >&2; exit 1;
}
for command in find flock git pnpm readlink rg rsync sha256sum sort sudo systemd-analyze; do
  command -v "$command" >/dev/null || {
    echo "refusing staging: required command is unavailable: $command" >&2; exit 1;
  }
done
node_runtime=/usr/local/bin/node
if [[ ! -x "$node_runtime" ]] \
  || (( $("$node_runtime" -p 'Number(process.versions.node.split(".")[0])') < 22 )); then
  echo 'refusing staging: system Node 22 or newer is unavailable' >&2
  exit 1
fi

acquire_recommendation_worker_deployment_lock
build_root="$(mktemp -d /tmp/openspell-recommendation-worker-install.XXXXXX)"
pnpm --dir "$repo_root" install --frozen-lockfile >"$build_root/install.log" 2>&1
node "$script_dir/test-recommendation-worker-deployment.mjs"
[[ -z "$(git -C "$repo_root" status --porcelain --untracked-files=normal)" ]] || {
  echo 'refusing staging: build preparation changed the checkout' >&2; exit 1;
}

release_stage="$build_root/release"
bash "$script_dir/build-recommendation-worker-artifact.sh" \
  --revision "$expected_revision" --output "$release_stage"
[[ "$(git -C "$repo_root" rev-parse HEAD)" == "$expected_revision" \
  && "$(git -C "$repo_root" rev-parse refs/remotes/origin/main)" == "$expected_revision" \
  && -z "$(git -C "$repo_root" status --porcelain --untracked-files=normal)" ]] || {
  echo 'refusing staging: approved source changed during the artifact build' >&2; exit 1;
}

release_dir="$recommendation_worker_release_root/releases/$expected_revision"
incoming_release="$recommendation_worker_release_root/releases/.incoming-$expected_revision-$$"
if sudo test -e "$release_dir"; then
  verify_recommendation_worker_artifact "$release_dir" "$expected_revision" true || {
    echo 'refusing staging: retained release provenance is invalid' >&2; exit 1;
  }
else
  sudo install -d -m 0755 -o root -g root \
    "$recommendation_worker_release_root/releases" "$incoming_release"
  sudo rsync -a --delete --chown=root:root "$release_stage/" "$incoming_release/"
  sudo diff -qr "$release_stage" "$incoming_release" >/dev/null || {
    echo 'refusing staging: installed artifact differs from staging' >&2; exit 1;
  }
  sudo mv -T "$incoming_release" "$release_dir"
  incoming_release=
fi
sudo diff -qr "$release_stage" "$release_dir" >/dev/null || {
  echo 'refusing staging: retained artifact reconciliation failed' >&2; exit 1;
}
echo "staged OpenSpell recommendation worker release $expected_revision"
echo 'current, unit definitions, enablement, and service state were not changed'
