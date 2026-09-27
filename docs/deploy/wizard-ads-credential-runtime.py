#!/usr/bin/env python3
"""Locked Evo runtime for the Wizard Ads worker and read-only MCP bridge.

Exact TPM-encrypted credentials are supplied by systemd. Agent processes can
invoke the MCP protocol over a Unix socket, but cannot request a credential,
choose a URL, or execute an arbitrary credentialed command.

Installed as credential_runtime.py at the root of a versioned worker release
(docs/deploy/build-evo-general-worker-artifact.sh). The worker, SP-API
connection, Amazon Ads connection and MCF modes run the release's own app/
directory and report the revision recorded in its REVISION file. Each
credential maps to exactly one environment variable; the public configuration
can never name a credential variable.

The mcf mode (WP-338f) runs only in wizard-ads-mcf.service. It reads its own
configuration, /etc/wizard-ads-mcf/mcf.json, never worker.json. It passes
CREDENTIALS_DIRECTORY to node so apps/worker/src/mcf-main.ts can read the
recipient private key files itself; this runtime lists their names and never
opens them, so a key never enters an environment variable.
"""
from __future__ import annotations

import argparse
import grp
import json
import os
import re
import socketserver
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


DATABASE_CREDENTIAL = "database-url"
MCP_TOKEN_CREDENTIAL = "wizard-ads-mcp-token"
# systemd credential name -> the only environment variable it may populate.
SPAPI_CREDENTIALS = {
    "spapi-lwa-client-id": "SP_API_LWA_CLIENT_ID",
    "spapi-lwa-client-secret-value": "SP_API_LWA_CLIENT_SECRET",
}
WORKER_CREDENTIALS = {DATABASE_CREDENTIAL: "DATABASE_URL", **SPAPI_CREDENTIALS}
# The Amazon Ads LWA application pair. Only the connection-only Ads mode reads
# it; the general worker's unit never loads it.
AMAZON_CREDENTIALS = {
    "ads-lwa-client-id": "LWA_CLIENT_ID",
    "ads-lwa-client-secret-value": "LWA_CLIENT_SECRET",
}
AMAZON_CONNECTION_CREDENTIALS = {DATABASE_CREDENTIAL: "DATABASE_URL", **AMAZON_CREDENTIALS}
RELEASE_ROOT = Path(__file__).resolve().parent
WORKER_CONFIG = Path("/etc/wizard-ads/worker.json")
NODE = "/usr/local/bin/node"
SPAPI_GATE = "OPENSPELL_SPAPI_CONNECTIONS_ENABLED"
SPAPI_SETTINGS = (
    "SP_API_APPLICATION_ID",
    "SP_API_OAUTH_REGION",
    "SP_API_OAUTH_ALLOWED_REDIRECT_URIS",
)
SPAPI_REGIONS = {"NA", "EU", "FE"}
AMAZON_GATE = "OPENSPELL_AMAZON_CONNECTIONS_ENABLED"
AMAZON_SETTINGS = ("AMAZON_OAUTH_ALLOWED_REDIRECT_URIS",)
# Read only by the Amazon Ads connection mode. The worker mode never passes
# them on: the worker config refuses the Ads loop without entity.sync.
AMAZON_KEYS = frozenset({AMAZON_GATE, *AMAZON_SETTINGS})
# WP-331's market-signals import (WP-336). Optional and non-secret; without the
# directory the import is off. Only the worker mode passes them on, after
# validation. ProtectHome=yes hides /home, /root and /run/user from the unit.
MARKET_SIGNALS_DIR = "OPENSPELL_MARKET_SIGNALS_DIR"
MARKET_SIGNALS_ORG_KEYS = "OPENSPELL_MARKET_SIGNALS_ORG_KEYS"
IMPORT_KEYS = frozenset({MARKET_SIGNALS_DIR, MARKET_SIGNALS_ORG_KEYS})
HIDDEN_ROOTS = ("/home", "/root", "/run/user")
IMPORT_DIRECTORY = re.compile(r"^(?:/[A-Za-z0-9._-]+)+$")
ORG_KEY_ENTRY = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}="
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
# WP-334's read-only MCF observation (WP-338b). Optional and non-secret; absent
# or 0 leaves it off. Only the worker mode passes them on, after validation. The
# worker (apps/worker/src/mcf-observe.ts) enables it only on exactly "1" with both
# SP-API LWA credentials, and reads the interval as whole minutes from 5 to 1440
# (30 when absent).
MCF_OBSERVE_GATE = "OPENSPELL_MCF_OBSERVE_ENABLED"
MCF_OBSERVE_INTERVAL = "OPENSPELL_MCF_OBSERVE_INTERVAL_MINUTES"
MCF_OBSERVE_KEYS = frozenset({MCF_OBSERVE_GATE, MCF_OBSERVE_INTERVAL})
MCF_OBSERVE_MINUTES = (5, 1440)
WHOLE_MINUTES = re.compile(r"^[1-9][0-9]{0,3}$")
# WP-338n's housekeeping alerts in the general worker (WP-338f wiring). The
# webhook URL is a secret: it arrives only as the optional systemd credential
# mcf-alert-webhook and can never be a worker.json key. The app URL is a
# non-secret https origin for the samples link.
MCF_ALERT_WEBHOOK_CREDENTIAL = "mcf-alert-webhook"
MCF_ALERT_WEBHOOK = "OPENSPELL_MCF_ALERT_WEBHOOK_URL"
WORKER_OPTIONAL_CREDENTIALS = {MCF_ALERT_WEBHOOK_CREDENTIAL: MCF_ALERT_WEBHOOK}
APP_URL = "WIZARD_ADS_APP_URL"
HOST_NAME = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$")
# The dedicated MCF send unit (WP-338f; DESIGN sections 4.3, 8 and 11). Its
# gate is two flags and a connection:marketplace scope; only the mcf mode
# accepts them, and every other mode refuses them by name.
MCF_CONFIG = Path("/etc/wizard-ads-mcf/mcf.json")
MCF_PREVIEW_GATE = "OPENSPELL_MCF_PREVIEW_ENABLED"
MCF_DISPATCH_GATE = "OPENSPELL_MCF_DISPATCH_ENABLED"
MCF_SCOPE = "OPENSPELL_MCF_SCOPE"
MCF_POLL_INTERVAL = "OPENSPELL_MCF_POLL_INTERVAL_MS"
MCF_SEND_KEYS = frozenset({MCF_PREVIEW_GATE, MCF_DISPATCH_GATE, MCF_SCOPE})
MCF_ENV_KEYS = frozenset({*MCF_SEND_KEYS, MCF_POLL_INTERVAL, "WORKER_ID"})
# Keys that belong to the MCF unit alone; worker.json refuses each by name.
MCF_UNIT_ONLY_KEYS = frozenset({*MCF_SEND_KEYS, MCF_POLL_INTERVAL})
MCF_CREDENTIALS = {DATABASE_CREDENTIAL: "DATABASE_URL", **SPAPI_CREDENTIALS}
# One credential per recipient key: this prefix plus the key id's first 8 hex
# characters (apps/worker/src/mcf-send/custody.ts). Only the mcf mode may see one.
MCF_RECIPIENT_PREFIX = "mcf-recipient-"
MCF_RECIPIENT_CREDENTIAL = re.compile(r"^mcf-recipient-[0-9a-f]{8}$")
MCF_SCOPE_ENTRY = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[A-Z0-9]{9,16}$"
)
MCF_MAX_SCOPE_ENTRIES = 50
MCF_POLL_MS = (1_000, 60_000)
MCF_POLL_DIGITS = re.compile(r"^[1-9][0-9]{3,4}$")
MCF_WORKER_ID = re.compile(r"^[A-Za-z0-9._:-]{1,70}$")
# systemd exports StateDirectory= as $STATE_DIRECTORY; with DynamicUser=yes the
# directory may be reported under /var/lib/private.
MCF_STATE_DIRECTORIES = ("/var/lib/wizard-ads-mcf", "/var/lib/private/wizard-ads-mcf")
CREDENTIAL_VALUE = re.compile(r"^[\x21-\x7e]{1,4096}$")
REVISION = re.compile(r"^[0-9a-f]{40}$")
MCP_UPSTREAM = "http://127.0.0.1:18787"
MAX_REQUEST = 2_000_000
MAX_RESPONSE = 32_000_000
ALLOWED_TOOLS = {
    "list_profiles",
    "get_sync_status",
    "get_entity_data",
    "query",
    "group_by",
    "download_data",
    "get_recommendations",
    "get_flags",
    "get_pacing",
    "list_experiments",
    "get_experiment",
}
ALLOWED_METHODS = {
    "initialize",
    "notifications/initialized",
    "notifications/cancelled",
    "ping",
    "tools/list",
    "tools/call",
    "resources/list",
    "resources/templates/list",
    "resources/read",
}
PROFILE_RESOURCE = re.compile(
    r"^wizardads://" + r"profiles/" + r"[0-9a-fA-F-]{8,64}$"
)
WORKER_ENV_KEYS = {
    "WORKER_ID",
    "WORKER_JOB_TYPES",
    "WORKER_MAX_CONCURRENT_JOBS",
    "WORKER_POLL_INTERVAL_MS",
    "WORKER_CLAIM_BATCH_SIZE",
    "WORKER_AUTH_HEALTHCHECK_MINUTES",
    "WORKER_STALE_CLAIM_AFTER",
    "CROSSCHECK_INBOX_DIR",
    "PORT",
    "WIZARD_ADS_WEEKLY_RECOMMENDATION_RUNS",
    SPAPI_GATE,
    *SPAPI_SETTINGS,
    *AMAZON_KEYS,
    *IMPORT_KEYS,
    *MCF_OBSERVE_KEYS,
    APP_URL,
}


# The Evo general worker's exact claim surface. sqp.request is the weekly
# Brand Analytics report request; the Vercel cron tick never claims it.
# mcf.observe is WP-334's read-only MCF observation (WP-338b); claiming it does
# nothing until OPENSPELL_MCF_OBSERVE_ENABLED is 1.
GENERAL_WORKER_JOB_TYPES = frozenset({
    "keepa.sync",
    "rank.sync",
    "economics.sync",
    "sqp.categorize",
    "sqp.request",
    "recommendations.run",
    "mcf.observe",
})


class Refused(RuntimeError):
    pass


def credentials_directory() -> Path:
    return Path(os.environ.get(
        "CREDENTIALS_DIRECTORY",
        "/run/credentials/wizard-ads-runtime.service",
    ))


def credential_file(name: str) -> Path:
    return credentials_directory() / name


def credential(name: str) -> str:
    try:
        value = credential_file(name).read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise RuntimeError(f"systemd runtime credential is unavailable: {name}") from exc
    if not value:
        raise RuntimeError(f"systemd runtime credential is empty: {name}")
    return value


def base_environment() -> dict[str, str]:
    return {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": "/var/lib/wizard-ads",
        "NODE_ENV": "production",
    }


def public_config() -> dict[str, str]:
    try:
        config = json.loads(WORKER_CONFIG.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError("worker public configuration is unavailable") from exc
    if isinstance(config, dict):
        # Named refusals for the MCF keys: the send gate belongs to the MCF
        # unit's own configuration, and the webhook is a credential.
        for key in sorted(MCF_UNIT_ONLY_KEYS & set(config)):
            raise RuntimeError(f"{key} belongs to the MCF unit's configuration ({MCF_CONFIG}), never worker.json")
        if MCF_ALERT_WEBHOOK in config:
            raise RuntimeError(
                f"{MCF_ALERT_WEBHOOK} is the systemd credential {MCF_ALERT_WEBHOOK_CREDENTIAL}, never a worker.json key"
            )
    if not isinstance(config, dict) or set(config) - WORKER_ENV_KEYS:
        raise RuntimeError("worker public configuration contains unsupported keys")
    if not all(isinstance(key, str) and isinstance(value, str)
               for key, value in config.items()):
        raise RuntimeError("worker public configuration is invalid")
    if any("<" in value or ">" in value for value in config.values()):
        raise RuntimeError("worker public configuration still contains a template placeholder")
    for gate in (SPAPI_GATE, AMAZON_GATE):
        if config.get(gate, "0") not in {"0", "1"}:
            raise RuntimeError(f"{gate} must be 0 or 1")
    region = config.get("SP_API_OAUTH_REGION")
    if region is not None and region not in SPAPI_REGIONS:
        raise RuntimeError("SP_API_OAUTH_REGION must be NA, EU or FE")
    return config


def general_worker_job_types(config: dict[str, str]) -> None:
    """The worker mode claims exactly the seven types; the connection-only modes claim none."""
    job_types = config.get("WORKER_JOB_TYPES", "").split(",")
    if len(job_types) != len(set(job_types)) or set(job_types) != GENERAL_WORKER_JOB_TYPES:
        raise RuntimeError(
            "WORKER_JOB_TYPES must list exactly these job types once each: "
            + ",".join(sorted(GENERAL_WORKER_JOB_TYPES))
        )


def market_signals_settings(config: dict[str, str]) -> None:
    """Refuse an import setting the hardened worker could not use; name the key, never the value."""
    directory = config.get(MARKET_SIGNALS_DIR)
    if directory is None:
        if MARKET_SIGNALS_ORG_KEYS in config:
            raise RuntimeError(f"{MARKET_SIGNALS_ORG_KEYS} requires {MARKET_SIGNALS_DIR}")
        return
    if not IMPORT_DIRECTORY.fullmatch(directory) or os.path.normpath(directory) != directory \
            or any(directory == root or directory.startswith(root + "/") for root in HIDDEN_ROOTS):
        raise RuntimeError(
            f"{MARKET_SIGNALS_DIR} must be a normalized absolute path outside "
            + ", ".join(HIDDEN_ROOTS)
        )
    org_keys = config.get(MARKET_SIGNALS_ORG_KEYS)
    if org_keys is None:
        return
    entries = org_keys.split(",")
    keys = [entry.split("=", 1)[0] for entry in entries]
    if not all(ORG_KEY_ENTRY.fullmatch(entry) for entry in entries) or len(keys) != len(set(keys)):
        raise RuntimeError(
            f"{MARKET_SIGNALS_ORG_KEYS} must be key=uuid[,key=uuid] with unique keys"
        )


def mcf_observe_settings(config: dict[str, str]) -> bool:
    """Refuse an observation setting the worker would read differently; name the key, never the value."""
    if config.get(MCF_OBSERVE_GATE, "0") not in {"0", "1"}:
        raise RuntimeError(f"{MCF_OBSERVE_GATE} must be 0 or 1")
    minutes = config.get(MCF_OBSERVE_INTERVAL)
    low, high = MCF_OBSERVE_MINUTES
    if minutes is not None and not (WHOLE_MINUTES.fullmatch(minutes) and low <= int(minutes) <= high):
        raise RuntimeError(
            f"{MCF_OBSERVE_INTERVAL} must be a whole number of minutes from {low} to {high}"
        )
    return config.get(MCF_OBSERVE_GATE) == "1"


def https_url(value: str, origin_only: bool) -> bool:
    """An https URL with a lower-case DNS host, no credentials and no fragment; an origin also has no path or query."""
    if not CREDENTIAL_VALUE.fullmatch(value):
        return False
    try:
        parts = urllib.parse.urlsplit(value)
        port = parts.port
    except ValueError:
        return False
    host = parts.hostname or ""
    if parts.scheme != "https" or parts.username is not None or parts.password is not None \
            or parts.fragment or "#" in value or not HOST_NAME.fullmatch(host) \
            or parts.netloc != (host if port is None else f"{host}:{port}"):
        return False
    if origin_only:
        return parts.path in {"", "/"} and not parts.query and "?" not in value
    return True


def app_url_setting(config: dict[str, str]) -> None:
    """WIZARD_ADS_APP_URL is optional; when set it must be an https origin. Names the key, never the value."""
    value = config.get(APP_URL)
    if value is not None and not https_url(value, origin_only=True):
        raise RuntimeError(f"{APP_URL} must be an https origin without a path, query, fragment or credentials")


def alert_webhook() -> dict[str, str]:
    """The optional mcf-alert-webhook credential; absent leaves alerts to the journal."""
    if not credential_file(MCF_ALERT_WEBHOOK_CREDENTIAL).exists():
        return {}
    value = credential(MCF_ALERT_WEBHOOK_CREDENTIAL)
    if not https_url(value, origin_only=False):
        raise RuntimeError(
            f"systemd runtime credential is invalid: {MCF_ALERT_WEBHOOK_CREDENTIAL} "
            "must be an https URL without credentials or fragment"
        )
    return {MCF_ALERT_WEBHOOK: value}


def credential_names() -> set[str]:
    """Names in the unit's credentials directory; never their contents."""
    try:
        return {entry.name for entry in credentials_directory().iterdir()}
    except OSError:
        return set()


def refuse_recipient_keys() -> None:
    """A recipient private key is loaded by wizard-ads-mcf.service alone; any other unit that holds one refuses to start.

    Matches the name anywhere, so a key imported under its store file name
    (ImportCredential=wizard-ads-*, say) is refused too.
    """
    if any(MCF_RECIPIENT_PREFIX in name for name in credential_names()):
        raise RuntimeError(
            "a recipient key credential (mcf-recipient-*) is loaded into a unit other than "
            "wizard-ads-mcf.service; remove its LoadCredentialEncrypted line"
        )


def release_revision() -> str:
    try:
        revision = (RELEASE_ROOT / "REVISION").read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise RuntimeError("worker release revision is unavailable") from exc
    if not REVISION.fullmatch(revision):
        raise RuntimeError("worker release revision is invalid")
    return revision


def database_url() -> str:
    database = credential(DATABASE_CREDENTIAL)
    if not database.startswith(("postgres://", "postgresql://")):
        raise RuntimeError("1Password database credential is invalid")
    return database


def spapi_credentials(required: bool) -> dict[str, str]:
    """Both LWA credentials or neither; a gate that is on requires both."""
    present = {name for name in SPAPI_CREDENTIALS if credential_file(name).exists()}
    if not present and not required:
        return {}
    if present != set(SPAPI_CREDENTIALS):
        raise RuntimeError(
            "SP-API LWA credentials must be supplied together: "
            + ", ".join(sorted(SPAPI_CREDENTIALS))
        )
    values: dict[str, str] = {}
    for name, variable in SPAPI_CREDENTIALS.items():
        value = credential(name)
        if not CREDENTIAL_VALUE.fullmatch(value):
            raise RuntimeError(f"1Password SP-API credential is invalid: {name}")
        values[variable] = value
    return values


def amazon_credentials() -> dict[str, str]:
    """The Amazon Ads mode requires both LWA credentials."""
    present = {name for name in AMAZON_CREDENTIALS if credential_file(name).exists()}
    if present != set(AMAZON_CREDENTIALS):
        raise RuntimeError(
            "Amazon Ads LWA credentials must be supplied together: "
            + ", ".join(sorted(AMAZON_CREDENTIALS))
        )
    values: dict[str, str] = {}
    for name, variable in AMAZON_CREDENTIALS.items():
        value = credential(name)
        if not CREDENTIAL_VALUE.fullmatch(value):
            raise RuntimeError(f"1Password Amazon Ads credential is invalid: {name}")
        values[variable] = value
    return values


def announce(mode: str, revision: str, spapi_enabled: bool,
             amazon_enabled: bool | None = None,
             extra: dict[str, str | int] | None = None) -> None:
    # Configuration identity only; never a credential value or a public setting.
    line: dict[str, str | int] = {
        "event": "wizard_ads_runtime_start",
        "mode": mode,
        "revision": revision,
        "spapiConnectionLoop": "enabled" if spapi_enabled else "disabled",
    }
    if amazon_enabled is not None:
        line["amazonConnectionLoop"] = "enabled" if amazon_enabled else "disabled"
    line.update(extra or {})
    print(json.dumps(line, separators=(",", ":")), flush=True)


def exec_release(mode: str, revision: str, spapi_enabled: bool,
                 entry: str, env: dict[str, str],
                 amazon_enabled: bool | None = None,
                 extra: dict[str, str | int] | None = None) -> None:
    root = RELEASE_ROOT / "app"
    runner = root / "node_modules/tsx/dist/cli.mjs"
    if not runner.is_file() or not (root / entry).is_file():
        raise RuntimeError("deployed worker runtime is unavailable")
    announce(mode, revision, spapi_enabled, amazon_enabled, extra)
    os.chdir(root)
    os.execve(NODE, [NODE, str(runner), entry], env)


def run_worker() -> None:
    config = public_config()
    general_worker_job_types(config)
    market_signals_settings(config)
    observe_enabled = mcf_observe_settings(config)
    app_url_setting(config)
    refuse_recipient_keys()
    revision = release_revision()
    spapi_enabled = config.get(SPAPI_GATE) == "1"
    if spapi_enabled and any(not config.get(name) for name in SPAPI_SETTINGS):
        raise RuntimeError(
            "SP-API connections require " + ", ".join(SPAPI_SETTINGS)
        )
    env = base_environment()
    env.update({key: value for key, value in config.items() if key not in AMAZON_KEYS})
    env["OPENSPELL_WORKER_REVISION"] = revision
    spapi = spapi_credentials(required=spapi_enabled)
    if observe_enabled and not spapi:
        # The worker would stay off silently; refuse instead so the flag means what it says.
        raise RuntimeError(
            f"{MCF_OBSERVE_GATE}=1 requires the SP-API LWA credentials: "
            + ", ".join(sorted(SPAPI_CREDENTIALS))
        )
    env.update(spapi)
    env.update(alert_webhook())
    env["DATABASE_URL"] = database_url()
    exec_release("worker", revision, spapi_enabled, "src/main.ts", env)


def run_spapi_connections() -> None:
    """Connection-only exchange, for when the general worker does not own it."""
    config = public_config()
    refuse_recipient_keys()
    revision = release_revision()
    if config.get(SPAPI_GATE) == "1":
        raise RuntimeError(
            "the general worker owns the SP-API connection loop; "
            f"set {SPAPI_GATE} to 0 in its configuration first"
        )
    missing = [name for name in SPAPI_SETTINGS if not config.get(name)]
    if missing:
        raise RuntimeError("SP-API connections require " + ", ".join(missing))
    env = base_environment()
    env.update({name: config[name] for name in SPAPI_SETTINGS})
    env[SPAPI_GATE] = "1"
    env.update(spapi_credentials(required=True))
    env["DATABASE_URL"] = database_url()
    exec_release("spapi-connections", revision, True, "src/spapi-connections-cli.ts", env)


def run_amazon_connections() -> None:
    """Connection-only Amazon Ads exchange and discovery.

    The general worker cannot own this loop: its configuration refuses it unless
    the worker also claims entity.sync, which the Vercel cron tick owns. This
    mode claims no job, so that rule does not apply to it.
    """
    config = public_config()
    refuse_recipient_keys()
    revision = release_revision()
    if config.get(AMAZON_GATE) != "1":
        raise RuntimeError(
            f"set {AMAZON_GATE} to 1 in the worker configuration "
            "to run the Amazon Ads connection loop"
        )
    missing = [name for name in AMAZON_SETTINGS if not config.get(name)]
    if missing:
        raise RuntimeError("Amazon Ads connections require " + ", ".join(missing))
    env = base_environment()
    env.update({name: config[name] for name in AMAZON_SETTINGS})
    env[AMAZON_GATE] = "1"
    env.update(amazon_credentials())
    env["DATABASE_URL"] = database_url()
    exec_release("amazon-connections", revision, False, "src/amazon-connections-cli.ts", env,
                 amazon_enabled=True)


def mcf_config() -> dict[str, str]:
    """The MCF unit's own public configuration; worker.json is never read in this mode."""
    try:
        config = json.loads(MCF_CONFIG.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError("MCF configuration is unavailable") from exc
    if not isinstance(config, dict) or not all(isinstance(key, str) and isinstance(value, str)
                                               for key, value in config.items()):
        raise RuntimeError("MCF configuration is invalid")
    for key in sorted(set(config) - MCF_ENV_KEYS):
        # The key is named so the operator can remove it; a value never is.
        if key in WORKER_ENV_KEYS or key == MCF_ALERT_WEBHOOK:
            raise RuntimeError(f"{key} belongs to the general worker, never the MCF unit's configuration")
        raise RuntimeError("MCF configuration contains unsupported keys")
    if any("<" in value or ">" in value for value in config.values()):
        raise RuntimeError("MCF configuration still contains a template placeholder")
    return config


def mcf_settings(config: dict[str, str]) -> tuple[bool, bool, list[str]]:
    """The host gate, parsed as apps/worker/src/mcf-send/policy.ts reads it, but stricter: no blanks or padding."""
    flags = []
    for gate in (MCF_PREVIEW_GATE, MCF_DISPATCH_GATE):
        if config.get(gate, "0") not in {"0", "1"}:
            raise RuntimeError(f"{gate} must be 0 or 1")
        flags.append(config.get(gate) == "1")
    raw_scope = config.get(MCF_SCOPE)
    scope: list[str] = []
    if raw_scope is not None:
        scope = raw_scope.split(",")
        if len(scope) > MCF_MAX_SCOPE_ENTRIES or not all(MCF_SCOPE_ENTRY.fullmatch(entry) for entry in scope) \
                or len(scope) != len(set(scope)):
            raise RuntimeError(
                f"{MCF_SCOPE} must be 1 to {MCF_MAX_SCOPE_ENTRIES} distinct "
                "<lower-case connection uuid>:<marketplace id> entries, comma-separated"
            )
    if any(flags) and not scope:
        raise RuntimeError(f"{MCF_PREVIEW_GATE} or {MCF_DISPATCH_GATE} is 1 without {MCF_SCOPE}")
    interval = config.get(MCF_POLL_INTERVAL)
    low, high = MCF_POLL_MS
    if interval is not None and not (MCF_POLL_DIGITS.fullmatch(interval) and low <= int(interval) <= high):
        raise RuntimeError(f"{MCF_POLL_INTERVAL} must be a whole number of milliseconds from {low} to {high}")
    worker_id = config.get("WORKER_ID")
    if worker_id is not None and not MCF_WORKER_ID.fullmatch(worker_id):
        raise RuntimeError("WORKER_ID must be 1 to 70 letters, digits, '.', '_', ':' or '-'")
    return flags[0], flags[1], scope


def run_mcf() -> None:
    """The MCF send unit (WP-338f). Refuses anything it does not need.

    Passes DATABASE_URL, the SP-API LWA pair (required with a scope, because
    settlement reads run with both flags off), its own configuration keys, the
    revision and CREDENTIALS_DIRECTORY. The recipient key files are listed by
    name, never opened. HOME is the unit's StateDirectory; NODE_OPTIONS is never
    set. Execs src/mcf-main.ts, which opens no listener.
    """
    config = mcf_config()
    preview, dispatch, scope = mcf_settings(config)
    revision = release_revision()
    directory = os.environ.get("CREDENTIALS_DIRECTORY", "")
    if not directory.startswith("/") or not Path(directory).is_dir():
        raise RuntimeError("the mcf mode runs only under systemd with its credentials directory")
    state = os.environ.get("STATE_DIRECTORY", "")
    if state not in MCF_STATE_DIRECTORIES:
        raise RuntimeError("the mcf mode runs only in wizard-ads-mcf.service (StateDirectory=wizard-ads-mcf)")
    names = credential_names()
    recipients = sorted(name for name in names if MCF_RECIPIENT_CREDENTIAL.fullmatch(name))
    unexpected = sorted(names - set(MCF_CREDENTIALS) - set(recipients))
    if unexpected:
        raise RuntimeError("wizard-ads-mcf.service loads a credential the mcf mode does not use: "
                           + ", ".join(unexpected))
    if (preview or dispatch) and not recipients:
        raise RuntimeError(
            f"{MCF_PREVIEW_GATE} or {MCF_DISPATCH_GATE} is 1 without a recipient key credential (mcf-recipient-<keyId8>)"
        )
    spapi = spapi_credentials(required=bool(scope))
    env = base_environment()
    env["HOME"] = state
    env.update(config)
    env["OPENSPELL_WORKER_REVISION"] = revision
    env["CREDENTIALS_DIRECTORY"] = directory
    env.update(spapi)
    env["DATABASE_URL"] = database_url()
    exec_release("mcf", revision, False, "src/mcf-main.ts", env, extra={
        "mcfPreview": "enabled" if preview else "disabled",
        "mcfDispatch": "enabled" if dispatch else "disabled",
        "mcfScopeEntries": len(scope),
        "mcfRecipientKeys": len(recipients),
    })


def jsonrpc_error(request: Any, message: str) -> dict[str, Any] | None:
    if not isinstance(request, dict) or "id" not in request:
        return None
    return {
        "jsonrpc": "2.0",
        "id": request.get("id"),
        "error": {"code": -32000, "message": message},
    }


def validate_request(request: Any) -> None:
    if not isinstance(request, dict) or request.get("jsonrpc") != "2.0":
        raise Refused("invalid MCP request")
    method = request.get("method")
    if method not in ALLOWED_METHODS:
        raise Refused("MCP method is not allowlisted")
    params = request.get("params") or {}
    if not isinstance(params, dict):
        raise Refused("MCP parameters are invalid")
    if method == "tools/call":
        if params.get("name") not in ALLOWED_TOOLS:
            raise Refused("MCP tool is not allowlisted")
    if method == "resources/read":
        uri = params.get("uri")
        if uri != "wizardads://instructions" and not (
            isinstance(uri, str) and PROFILE_RESOURCE.fullmatch(uri)
        ):
            raise Refused("MCP resource is not allowlisted")


def filter_response(request: dict[str, Any], response: Any) -> Any:
    if request.get("method") != "tools/list" or not isinstance(response, dict):
        return response
    result = response.get("result")
    if not isinstance(result, dict) or not isinstance(result.get("tools"), list):
        return response
    result["tools"] = [
        tool for tool in result["tools"]
        if isinstance(tool, dict) and tool.get("name") in ALLOWED_TOOLS
    ]
    return response


class Proxy:
    def __init__(self, token: str) -> None:
        self.token = token

    def health(self) -> dict[str, Any]:
        try:
            with urllib.request.urlopen(f"{MCP_UPSTREAM}/healthz", timeout=5) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
            raise Refused("Wizard Ads MCP upstream is unavailable") from exc
        if payload.get("status") != "ok":
            raise Refused("Wizard Ads MCP upstream is unhealthy")
        return {"status": "ok", "operations_version": 1}

    def forward(self, request: dict[str, Any]) -> Any:
        validate_request(request)
        outgoing = urllib.request.Request(
            f"{MCP_UPSTREAM}/mcp",
            data=json.dumps(request, separators=(",", ":")).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(outgoing, timeout=180) as response:
                body = response.read(MAX_RESPONSE + 1)
        except urllib.error.HTTPError as exc:
            body = exc.read(MAX_RESPONSE + 1)
        except (urllib.error.URLError, OSError) as exc:
            raise Refused("Wizard Ads MCP request failed") from exc
        if len(body) > MAX_RESPONSE:
            raise Refused("Wizard Ads MCP response exceeds the byte cap")
        if not body:
            return None
        try:
            parsed = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise Refused("Wizard Ads MCP returned an invalid response") from exc
        return filter_response(request, parsed)


class Handler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        raw = self.rfile.readline(MAX_REQUEST + 1)
        if len(raw) > MAX_REQUEST:
            self.emit(False, message="request exceeds the byte cap")
            return
        try:
            envelope = json.loads(raw)
            if envelope == {"version": 1, "operation": "health"}:
                self.emit(True, response=self.server.proxy.health())
                return
            if not isinstance(envelope, dict) or set(envelope) != {"version", "request"} \
                    or envelope.get("version") != 1:
                raise Refused("invalid bridge request")
            request = envelope["request"]
            response = self.server.proxy.forward(request)
            self.emit(True, response=response)
        except Refused as exc:
            request = envelope.get("request") if isinstance(envelope, dict) else None
            self.emit(True, response=jsonrpc_error(request, str(exc)))
        except (json.JSONDecodeError, TypeError, ValueError):
            self.emit(False, message="invalid bridge request")
        except Exception:
            self.emit(False, message="bridge operation failed")

    def emit(self, ok: bool, **payload: Any) -> None:
        encoded = json.dumps(
            {"version": 1, "ok": ok, **payload}, separators=(",", ":")
        ).encode("utf-8") + b"\n"
        if len(encoded) > MAX_RESPONSE:
            encoded = b'{"version":1,"ok":false,"message":"bridge response exceeds the byte cap"}\n'
        self.wfile.write(encoded)


class Server(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, path: Path, proxy: Proxy, agent_uid: int) -> None:
        directory_acl = subprocess.run(
            ["/usr/bin/setfacl", "--modify", f"user:{agent_uid}:rx", "--", str(path.parent)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )
        if directory_acl.returncode:
            raise RuntimeError("could not grant the installed agent user directory access")
        path.unlink(missing_ok=True)
        super().__init__(str(path), Handler)
        self.proxy = proxy
        os.chown(path, -1, grp.getgrnam("wizard-ads-agents").gr_gid)
        os.chmod(path, 0o660)
        socket_acl = subprocess.run(
            ["/usr/bin/setfacl", "--modify", f"user:{agent_uid}:rw", "--", str(path)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )
        if socket_acl.returncode:
            self.server_close()
            path.unlink(missing_ok=True)
            raise RuntimeError("could not grant the installed agent user socket access")


def wait_for_upstream(process: subprocess.Popen[str], proxy: Proxy) -> None:
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("Wizard Ads MCP runtime stopped during startup")
        try:
            proxy.health()
            return
        except Refused:
            time.sleep(0.5)
    raise RuntimeError("Wizard Ads MCP runtime did not become healthy")


def run_mcp() -> None:
    database = credential(DATABASE_CREDENTIAL)
    token = credential(MCP_TOKEN_CREDENTIAL)
    if not database.startswith(("postgres://", "postgresql://")):
        raise RuntimeError("1Password database credential is invalid")
    if not token.startswith("wza_"):
        raise RuntimeError("1Password MCP credential is invalid")
    root = Path("/usr/local/lib/wizard-ads-runtime/mcp")
    executable = root / "node_modules/.bin/tsx"
    if not executable.is_file():
        raise RuntimeError("deployed MCP runtime is unavailable")
    env = base_environment()
    env.update({
        "DATABASE_URL": database,
        "WIZARD_ADS_MCP_HOST": "127.0.0.1",
        "WIZARD_ADS_MCP_PORT": "18787",
    })
    database = ""
    process = subprocess.Popen(
        [str(executable), "src/bin/serve.ts"], cwd=root, env=env,
        stdin=subprocess.DEVNULL, text=True,
    )
    env["DATABASE_URL"] = ""
    proxy = Proxy(token)
    token = ""
    wait_for_upstream(process, proxy)
    try:
        agent_uid = int(Path("/etc/wizard-ads/agent-uid").read_text(encoding="utf-8").strip())
    except (OSError, ValueError) as exc:
        raise RuntimeError("installed agent UID is unavailable") from exc
    if agent_uid < 1:
        raise RuntimeError("installed agent UID is invalid")
    socket_path = Path("/run/wizard-ads/mcp.sock")
    server = Server(socket_path, proxy, agent_uid)

    def stop_when_child_exits() -> None:
        process.wait()
        server.shutdown()

    threading.Thread(target=stop_when_child_exits, daemon=True).start()
    try:
        server.serve_forever()
    finally:
        server.server_close()
        socket_path.unlink(missing_ok=True)
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
    if process.returncode:
        raise RuntimeError("Wizard Ads MCP runtime stopped unexpectedly")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("worker", "spapi-connections", "amazon-connections", "mcf", "mcp"))
    args = parser.parse_args()
    os.umask(0o007)
    if args.mode == "worker":
        run_worker()
    elif args.mode == "mcf":
        run_mcf()
    elif args.mode == "spapi-connections":
        run_spapi_connections()
    elif args.mode == "amazon-connections":
        run_amazon_connections()
    else:
        run_mcp()


if __name__ == "__main__":
    main()
