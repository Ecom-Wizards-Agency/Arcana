#!/usr/bin/env python3
"""Locked Evo runtime for the Wizard Ads worker and read-only MCP bridge.

Exact TPM-encrypted credentials are supplied by systemd. Agent processes can
invoke the MCP protocol over a Unix socket, but cannot request a credential,
choose a URL, or execute an arbitrary credentialed command.

Installed as credential_runtime.py at the root of a versioned worker release
(docs/deploy/build-evo-general-worker-artifact.sh). The worker and SP-API
connection modes run the release's own app/ directory and report the revision
recorded in its REVISION file. Each credential maps to exactly one environment
variable; the public configuration can never name a credential variable.
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
}


class Refused(RuntimeError):
    pass


def credential_file(name: str) -> Path:
    directory = Path(os.environ.get(
        "CREDENTIALS_DIRECTORY",
        "/run/credentials/wizard-ads-runtime.service",
    ))
    return directory / name


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
    if not isinstance(config, dict) or set(config) - WORKER_ENV_KEYS:
        raise RuntimeError("worker public configuration contains unsupported keys")
    if not all(isinstance(key, str) and isinstance(value, str)
               for key, value in config.items()):
        raise RuntimeError("worker public configuration is invalid")
    if any("<" in value or ">" in value for value in config.values()):
        raise RuntimeError("worker public configuration still contains a template placeholder")
    if config.get(SPAPI_GATE, "0") not in {"0", "1"}:
        raise RuntimeError(f"{SPAPI_GATE} must be 0 or 1")
    region = config.get("SP_API_OAUTH_REGION")
    if region is not None and region not in SPAPI_REGIONS:
        raise RuntimeError("SP_API_OAUTH_REGION must be NA, EU or FE")
    return config


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


def announce(mode: str, revision: str, spapi_enabled: bool) -> None:
    # Configuration identity only; never a credential value or a public setting.
    print(json.dumps({
        "event": "wizard_ads_runtime_start",
        "mode": mode,
        "revision": revision,
        "spapiConnectionLoop": "enabled" if spapi_enabled else "disabled",
    }, separators=(",", ":")), flush=True)


def exec_release(mode: str, revision: str, spapi_enabled: bool,
                 entry: str, env: dict[str, str]) -> None:
    root = RELEASE_ROOT / "app"
    runner = root / "node_modules/tsx/dist/cli.mjs"
    if not runner.is_file() or not (root / entry).is_file():
        raise RuntimeError("deployed worker runtime is unavailable")
    announce(mode, revision, spapi_enabled)
    os.chdir(root)
    os.execve(NODE, [NODE, str(runner), entry], env)


def run_worker() -> None:
    config = public_config()
    revision = release_revision()
    spapi_enabled = config.get(SPAPI_GATE) == "1"
    if spapi_enabled and any(not config.get(name) for name in SPAPI_SETTINGS):
        raise RuntimeError(
            "SP-API connections require " + ", ".join(SPAPI_SETTINGS)
        )
    env = base_environment()
    env.update(config)
    env["OPENSPELL_WORKER_REVISION"] = revision
    env.update(spapi_credentials(required=spapi_enabled))
    env["DATABASE_URL"] = database_url()
    exec_release("worker", revision, spapi_enabled, "src/main.ts", env)


def run_spapi_connections() -> None:
    """Connection-only exchange, for when the general worker does not own it."""
    config = public_config()
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
    parser.add_argument("mode", choices=("worker", "spapi-connections", "mcp"))
    args = parser.parse_args()
    os.umask(0o007)
    if args.mode == "worker":
        run_worker()
    elif args.mode == "spapi-connections":
        run_spapi_connections()
    else:
        run_mcp()


if __name__ == "__main__":
    main()
