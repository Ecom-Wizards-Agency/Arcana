#!/usr/bin/env bash
# Installs a reviewed public CA only. No credential, DB or service operation.
set -euo pipefail
[[ $# == 6 && "$1" == --revision && "$2" =~ ^[0-9a-f]{40}$ \
  && "$3" == --certificate && "$5" == --sha256 && "$6" =~ ^[0-9a-f]{64}$ ]] || {
  echo 'usage: install-recommendation-database-ca.sh --revision <full-main-revision> --certificate <reviewed-pem> --sha256 <approved-sha256>' >&2; exit 2;
}
revision="$2" certificate="$4" expected_digest="$6"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(git -C "$script_dir" rev-parse --show-toplevel)"
verify_source() {
  [[ "$(git -C "$repo_root" rev-parse HEAD)" == "$revision" \
    && "$(git -C "$repo_root" rev-parse refs/remotes/origin/main)" == "$revision" \
    && -z "$(git -C "$repo_root" status --porcelain --untracked-files=normal)" ]] || {
    echo 'refusing CA installation: source must be clean exact approved main' >&2; return 1;
  }
}
verify_source
[[ -f "$certificate" && ! -L "$certificate" ]] || {
  echo 'refusing CA installation: input must be a regular certificate file' >&2; exit 1;
}
# shellcheck source=docs/deploy/recommendation-worker-evo-systemd-lib.sh
source "$script_dir/recommendation-worker-evo-systemd-lib.sh"
stage="$(mktemp -d /tmp/openspell-recommendation-ca.XXXXXX)"
incoming=
cleanup() {
  rm -rf -- "$stage"
  [[ -z "$incoming" ]] || sudo rm -f -- "$incoming"
  release_recommendation_worker_deployment_lock
}
trap cleanup EXIT
install -m 0600 "$certificate" "$stage/ca.pem"
[[ "$(sha256sum "$stage/ca.pem" | cut -d ' ' -f 1)" == "$expected_digest" ]] || {
  echo 'refusing CA installation: input digest differs' >&2; exit 1;
}
node --input-type=module - "$script_dir" "$stage/ca.pem" <<'NODE'
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import * as tls from 'node:tls';
const { parseRecommendationDatabaseCa } = await import(pathToFileURL(`${process.argv[2]}/openspell-recommendation-database-trust.mjs`));
parseRecommendationDatabaseCa(readFileSync(process.argv[3], 'utf8'));
if (typeof tls.setDefaultCACertificates !== 'function') throw new Error('Custom CA requires Node 22.19 or newer');
NODE
# The dedicated service uses this fixed system runtime, not the build runtime.
/usr/local/bin/node --input-type=module -e \
  'import * as tls from "node:tls"; if (typeof tls.setDefaultCACertificates !== "function") process.exit(1)' || {
  echo 'refusing CA installation: system Node lacks custom CA support' >&2; exit 1;
}
acquire_recommendation_worker_deployment_lock
verify_source
for parent in / /etc /etc/openspell; do
  if sudo test -e "$parent" || sudo test -L "$parent"; then
    [[ "$(sudo stat -c '%F:%u:%g:%a' "$parent")" == directory:0:0:755 ]] || {
      echo 'refusing CA installation: parent is unsafe' >&2; exit 1;
    }
  fi
done
destination=/etc/openspell/recommendation-database-ca.pem
if sudo test -e "$destination" || sudo test -L "$destination"; then
  [[ "$(sudo stat -c '%F:%u:%g:%a' "$destination")" == 'regular file:0:0:644' \
    && "$(sudo sha256sum "$destination" | cut -d ' ' -f 1)" == "$expected_digest" ]] || {
    echo 'refusing CA installation: retained certificate differs or is unsafe' >&2; exit 1;
  }
else
  sudo install -d -m 0755 -o root -g root /etc/openspell
  incoming="$(sudo mktemp /etc/openspell/.recommendation-database-ca.XXXXXX)"
  sudo install -m 0644 -o root -g root "$stage/ca.pem" "$incoming"
  [[ "$(sudo sha256sum "$incoming" | cut -d ' ' -f 1)" == "$expected_digest" ]] || exit 1
  # Atomic no-replace publication. A concurrent or retained file is never overwritten.
  sudo ln -T -- "$incoming" "$destination"
  sudo rm -f -- "$incoming"
  incoming=
fi
echo 'verified fixed recommendation database CA; services and host trust were not changed'
