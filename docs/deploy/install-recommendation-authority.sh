#!/usr/bin/env bash
set -euo pipefail

[[ $# == 2 && "$1" == --revision && "$2" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'usage: install-recommendation-authority.sh --revision <full-git-object-id>' >&2; exit 2;
}
revision="$2"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(git -C "$script_dir" rev-parse --show-toplevel)"
[[ "$(git -C "$repo_root" rev-parse HEAD)" == "$revision" \
  && "$(git -C "$repo_root" rev-parse refs/remotes/origin/main)" == "$revision" \
  && -z "$(git -C "$repo_root" status --porcelain --untracked-files=normal)" ]] || {
  echo 'refusing authority installation: source must be clean exact approved main' >&2; exit 1;
}
for command in pnpm readlink sudo rsync flock sha256sum; do
  command -v "$command" >/dev/null || { echo 'authority installation tool unavailable' >&2; exit 1; }
done
node_runtime="$(readlink -f /usr/local/bin/node)"
[[ -f "$node_runtime" && -x "$node_runtime" ]] \
  && (( $("$node_runtime" -p 'Number(process.versions.node.split(".")[0])') >= 22 )) || {
  echo 'authority installation requires system Node 22 or newer' >&2; exit 1;
}
# Share the worker deployment lock so a transition cannot race a broker update.
# shellcheck source=docs/deploy/recommendation-worker-evo-systemd-lib.sh
source "$script_dir/recommendation-worker-evo-systemd-lib.sh"
build_root="$(mktemp -d /tmp/openspell-authority-build.XXXXXX)"
incoming=
temporary_launcher=
cleanup() {
  case "$build_root" in /tmp/openspell-authority-build.*) find "$build_root" -depth -delete 2>/dev/null || true;; esac
  case "$incoming" in /opt/openspell-recommendation-authority/releases/.incoming-*) sudo find "$incoming" -xdev -depth -delete 2>/dev/null || true;; esac
  case "$temporary_launcher" in /usr/local/libexec/.openspell-authority-*) sudo rm -f -- "$temporary_launcher";; esac
  release_recommendation_worker_deployment_lock
}
trap cleanup EXIT
pnpm --dir "$repo_root" install --frozen-lockfile >"$build_root/install.log" 2>&1
pnpm --dir "$repo_root" exec tsx "$repo_root/tools/recommendation-authority/src/build.ts" \
  "$revision" "$build_root/release" "$node_runtime"
[[ "$(git -C "$repo_root" rev-parse HEAD)" == "$revision" \
  && "$(git -C "$repo_root" rev-parse refs/remotes/origin/main)" == "$revision" \
  && -z "$(git -C "$repo_root" status --porcelain --untracked-files=normal)" ]] || {
  echo 'refusing authority installation: source revision changed during build' >&2; exit 1;
}
"$node_runtime" - "$repo_root" "$revision" "$build_root/release/SOURCE_INPUTS" <<'NODE'
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const [root, revision, manifest] = process.argv.slice(2);
const lines = readFileSync(manifest, 'utf8').trimEnd().split('\n');
let counted = 0;
for (const line of lines) {
  const digest = line.slice(0, 64), path = line.slice(66);
  if (path.startsWith('node_modules/')) continue; // Pinned driver inputs are recorded separately.
  const expected = execFileSync('git', ['-C', root, 'cat-file', 'blob', `${revision}:${path}`]);
  if (createHash('sha256').update(expected).digest('hex') !== digest) {
    throw new Error('authority compiled source differs from approved Git revision');
  }
  counted += 1;
}
if (counted < 4) throw new Error('authority source census did not close');
NODE
acquire_recommendation_worker_deployment_lock
release_root=/opt/openspell-recommendation-authority/releases
release="$release_root/$revision"
launcher=/usr/local/libexec/openspell-recommendation-authority
# Refuse unsafe existing parents before privileged mkdir/copy. No symlink may
# redirect installation into another tree, even if its leaf looks safe.
for parent in /opt /opt/openspell-recommendation-authority "$release_root" /usr /usr/local /usr/local/libexec; do
  if sudo test -e "$parent" || sudo test -L "$parent"; then
    [[ "$(sudo stat -c '%F:%u:%g:%a' "$parent")" == directory:0:0:755 ]] || {
      echo 'authority installation parent is unsafe' >&2; exit 1;
    }
  fi
done
runtime_parent="$node_runtime"
while :; do
  kind=directory
  [[ "$runtime_parent" != "$node_runtime" ]] || kind='regular file'
  [[ "$(sudo stat -c '%F:%u:%g:%a' "$runtime_parent")" == "$kind:0:0:755" ]] || {
    echo 'authority system runtime path is unsafe' >&2; exit 1;
  }
  [[ "$runtime_parent" != / ]] || break
  runtime_parent="$(dirname "$runtime_parent")"
done
sudo install -d -m 0755 -o root -g root "$release_root" /usr/local/libexec
if sudo test -e "$release" || sudo test -L "$release"; then
  sudo test -d "$release" && ! sudo test -L "$release" || exit 1
  sudo diff -qr "$build_root/release" "$release" >/dev/null || {
    echo 'retained authority release differs; refusing replacement' >&2; exit 1;
  }
else
  incoming="$release_root/.incoming-$revision-$$"
  ! sudo test -e "$incoming" && ! sudo test -L "$incoming" || exit 1
  sudo install -d -m 0755 -o root -g root "$incoming"
  sudo rsync -a --chown=root:root "$build_root/release/" "$incoming/"
  sudo diff -qr "$build_root/release" "$incoming" >/dev/null || exit 1
  sudo mv -T "$incoming" "$release"
  incoming=
fi
# Verify immutable root custody and every byte before changing the launcher.
sudo /usr/bin/env -i LANG=C "$node_runtime" "$release/verify.mjs" --release "$revision"
# A root-owned launcher pins the immutable bundle and a resolved system binary.
# env -i prevents caller NODE_OPTIONS/NODE_PATH from becoming runtime imports.
if sudo test -e "$launcher" || sudo test -L "$launcher"; then
  sudo test -f "$launcher" && ! sudo test -L "$launcher" \
    && [[ "$(sudo stat -c '%u:%g:%a' "$launcher")" == 0:0:755 ]] || exit 1
fi
temporary_launcher="/usr/local/libexec/.openspell-authority-$revision-$$"
! sudo test -e "$temporary_launcher" && ! sudo test -L "$temporary_launcher" || exit 1
sudo install -m 0755 -o root -g root "$release/LAUNCHER" "$temporary_launcher"
sudo mv -T "$temporary_launcher" "$launcher"
temporary_launcher=
sudo /usr/bin/env -i LANG=C "$node_runtime" "$release/verify.mjs" --installed
echo "installed verified OpenSpell recommendation authority $revision"
