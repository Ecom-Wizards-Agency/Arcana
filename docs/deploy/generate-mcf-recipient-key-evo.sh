#!/usr/bin/env bash
# Generate a recipient key pair for wizard-ads-mcf.service on the Evo (WP-338f):
#
#   sudo bash docs/deploy/generate-mcf-recipient-key-evo.sh
#
# The P-256 private key exists only in this process's memory and, encrypted with
# systemd-creds --with-key=host+tpm2, in
# /etc/credstore.encrypted/wizard-ads-mcf-recipient-<keyId8>.cred. No other copy is
# written. keyId is the hex SHA-256 of the public key's SPKI DER, the value the web
# app and apps/worker/src/mcf-send/custody.ts compute.
#
# Order: generate, derive the keyId and the public JWK, check them, and only then
# encrypt to a staging name, prove the staged credential decrypts to the same
# keyId, and rename it into place. The public value (for Vercel and the grant) goes
# to /etc/wizard-ads-mcf/recipient-<keyId8>.public.json last. A failure before the
# rename leaves no credential and no public file.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=docs/deploy/mcf-evo-systemd-lib.sh
source "$script_dir/mcf-evo-systemd-lib.sh"
if [[ "$EUID" -ne 0 && -z "$mcf_root" ]]; then
  echo "refusing: run with sudo; systemd-creds needs root" >&2
  exit 1
fi
for command in openssl od python3 sha256sum systemd-creds; do
  command -v "$command" >/dev/null || { echo "refusing: required command is unavailable: $command" >&2; exit 1; }
done
if [[ -z "$mcf_root" ]] && ! systemd-creds has-tpm2 >/dev/null 2>&1; then
  echo "refusing: systemd-creds reports no usable TPM2; the recipient key must be sealed with host+tpm2" >&2
  exit 1
fi
umask 077
store="$(mcf_path "$mcf_credstore")"
public_dir="$(mcf_path "$mcf_config_dir")"
staged=
cleanup() {
  if [[ -n "$staged" && -e "$staged" ]]; then
    rm -f -- "$staged"
  fi
}
trap cleanup EXIT

# 1. Generate and derive, in memory.
key_pem="$(openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256)"
spki_hex="$(printf '%s\n' "$key_pem" | openssl pkey -pubout -outform DER | od -An -v -tx1 | tr -d ' \n')"
key_id="$(printf '%s\n' "$key_pem" | openssl pkey -pubout -outform DER | sha256sum | cut -c1-64)"
public_json="$(python3 - "$key_id" "$spki_hex" <<'PY'
import base64, hashlib, json, re, sys
key_id, spki_hex = sys.argv[1:]
spki = bytes.fromhex(spki_hex)
prefix = bytes.fromhex("3059301306072a8648ce3d020106082a8648ce3d030107034200")
if len(spki) != 91 or spki[:26] != prefix or spki[26] != 4:
    sys.exit("refusing: not an uncompressed P-256 public key")
if not re.fullmatch(r"[0-9a-f]{64}", key_id) or hashlib.sha256(spki).hexdigest() != key_id:
    sys.exit("refusing: the key id is not the SHA-256 of the public key's SPKI DER")
b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()
print(json.dumps({"keyId": key_id, "jwk": {"kty": "EC", "crv": "P-256",
                  "x": b64(spki[27:59]), "y": b64(spki[59:91])}}, separators=(",", ":")))
PY
)"
key8="${key_id:0:8}"
target="$store/wizard-ads-mcf-recipient-$key8.cred"
public="$public_dir/recipient-$key8.public.json"
if [[ -e "$target" || -e "$public" ]]; then
  echo "refusing: a key with id prefix $key8 already exists; run again for a new pair" >&2
  exit 1
fi

# 2. Encrypt to a staging name, prove it, then rename into place.
staged="$store/.wizard-ads-mcf-recipient-$key8.cred.staged"
printf '%s\n' "$key_pem" | openssl pkey -outform DER \
  | systemd-creds encrypt --with-key=host+tpm2 --name="mcf-recipient-$key8" - "$staged"
unset key_pem
chmod 0600 "$staged"
if ! check_id="$(systemd-creds decrypt --name="mcf-recipient-$key8" "$staged" - \
  | openssl pkey -inform DER -pubout -outform DER 2>/dev/null | sha256sum | cut -c1-64)" \
  || [[ "$check_id" != "$key_id" ]]; then
  echo "refusing: the encrypted credential does not decrypt to the generated key" >&2
  exit 1
fi
mv -T -- "$staged" "$target"
staged=

# 3. The public value: a JWK and the keyId, no private member.
install -d -m 0755 "$public_dir"
printf '%s\n' "$public_json" >"$public.new"
chmod 0644 "$public.new"
mv -T -- "$public.new" "$public"
echo "keyId: $key_id"
echo "credential: ${target#"$mcf_root"}"
echo "public value (for Vercel and the grant): ${public#"$mcf_root"}"
echo "next: rerun install-mcf-evo-systemd.sh so the unit loads the key"
