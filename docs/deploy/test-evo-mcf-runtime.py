#!/usr/bin/env python3
"""Tests for the mcf mode (WP-338f) and the mcf-sandbox mode (WP-338k) of
wizard-ads-credential-runtime.py.

The mcf mode runs only in wizard-ads-mcf.service. These tests run against
synthetic credentials in a temporary directory; os.execve is replaced, so no
worker, database or network is ever reached, and no key is ever generated.
"""
from __future__ import annotations

import importlib.util
import io
import json
import os
import re
import stat
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("credential_runtime", HERE / "wizard-ads-credential-runtime.py")
assert SPEC and SPEC.loader
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)

REVISION = "0123456789abcdef0123456789abcdef01234567"
# Synthetic values assembled at runtime; none is a real credential or id.
DATABASE = "postgres" + "ql://synthetic:" + "fixture@127.0.0.1:5432/postgres"
CLIENT_ID = "synthetic-lwa-" + "client-id-0001"
CLIENT_SECRET = "synthetic-lwa-" + "client-value-0002"
KEY_NAME = "mcf-recipient-" + "0badc0de"
# Stands in for PKCS#8 bytes: if the runtime ever read the key, this would show.
KEY_CANARY = "synthetic-recipient-" + "key-canary-7f3a"
CONNECTION = "0f0e0d0c-0b0a-4908-8706-" + "050403020100"
MARKETPLACE = "SYNTHMKT" + "0001"
SCOPE = f"{CONNECTION}:{MARKETPLACE}"
STATE = "/var/lib/wizard-ads-mcf"
OFF_CONFIG = {
    "OPENSPELL_MCF_PREVIEW_ENABLED": "0",
    "OPENSPELL_MCF_DISPATCH_ENABLED": "0",
}
ON_CONFIG = {
    "OPENSPELL_MCF_PREVIEW_ENABLED": "1",
    "OPENSPELL_MCF_DISPATCH_ENABLED": "1",
    "OPENSPELL_MCF_SCOPE": SCOPE,
}
STATIC_CREDENTIALS = {
    "database-url": DATABASE,
    "spapi-lwa-client-id": CLIENT_ID,
    "spapi-lwa-client-secret-value": CLIENT_SECRET,
}
FLAG_REFUSAL = "{} must be 0 or 1"
SCOPE_REFUSAL = ("OPENSPELL_MCF_SCOPE must be 1 to 50 distinct "
                 "<lower-case connection uuid>:<marketplace id> entries, comma-separated")
SCOPE_REQUIRED = ("OPENSPELL_MCF_PREVIEW_ENABLED or OPENSPELL_MCF_DISPATCH_ENABLED is 1 "
                  "without OPENSPELL_MCF_SCOPE")
KEY_REQUIRED = ("OPENSPELL_MCF_PREVIEW_ENABLED or OPENSPELL_MCF_DISPATCH_ENABLED is 1 "
                "without a recipient key credential (mcf-recipient-<keyId8>)")
LWA_REQUIRED = ("SP-API LWA credentials must be supplied together: "
                "spapi-lwa-client-id, spapi-lwa-client-secret-value")
INTERVAL_REFUSAL = "OPENSPELL_MCF_POLL_INTERVAL_MS must be a whole number of milliseconds from 1000 to 60000"
WORKER_ID_REFUSAL = "WORKER_ID must be 1 to 70 letters, digits, '.', '_', ':' or '-'"
UNIT_ONLY = "the mcf mode runs only in wizard-ads-mcf.service (StateDirectory=wizard-ads-mcf)"


class Exec(Exception):
    def __init__(self, path: str, argv: list[str], env: dict[str, str]) -> None:
        super().__init__(path)
        self.path, self.argv, self.env = path, argv, env


class McfCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.release = root / "release"
        (self.release / "app/node_modules/tsx/dist").mkdir(parents=True)
        (self.release / "app/src").mkdir(parents=True)
        (self.release / "app/node_modules/tsx/dist/cli.mjs").write_text("")
        (self.release / "app/src/mcf-main.ts").write_text("")
        (self.release / "REVISION").write_text(REVISION + "\n")
        self.credentials = root / "credentials"
        self.credentials.mkdir()
        self.config = root / "mcf.json"
        # The mcf mode must never read worker.json: point it at garbage.
        self.worker_config = root / "worker.json"
        self.worker_config.write_text("not json")
        self.cwd = os.getcwd()
        for name, value in (
            ("RELEASE_ROOT", self.release),
            ("MCF_CONFIG", self.config),
            ("WORKER_CONFIG", self.worker_config),
            ("NODE", "/fixture/node"),
        ):
            patcher = mock.patch.object(runtime, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = mock.patch.dict(os.environ, {
            "CREDENTIALS_DIRECTORY": str(self.credentials),
            "STATE_DIRECTORY": STATE,
            # systemd never sets it; if it leaked in, the mode must still not pass it.
            "NODE_OPTIONS": "--require=/fixture/preload.js",
        })
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self) -> None:
        os.chdir(self.cwd)
        for entry in self.credentials.iterdir():
            entry.chmod(stat.S_IRUSR | stat.S_IWUSR)
        self.tmp.cleanup()

    def write(self, config: dict[str, str], credentials: dict[str, str]) -> None:
        self.config.write_text(json.dumps(config))
        for leftover in self.credentials.iterdir():
            leftover.chmod(stat.S_IRUSR | stat.S_IWUSR)
            leftover.unlink()
        for name, value in credentials.items():
            (self.credentials / name).write_text(value + "\n")

    def launch(self) -> tuple[Exec, list[dict[str, object]]]:
        def execve(path: str, argv: list[str], env: dict[str, str]) -> None:
            raise Exec(path, argv, env)
        output = io.StringIO()
        with mock.patch.object(runtime.os, "execve", execve), redirect_stdout(output):
            with self.assertRaises(Exec) as caught:
                runtime.run_mcf()
        lines = [json.loads(line) for line in output.getvalue().splitlines()]
        return caught.exception, lines

    def refuse(self, fragment: str) -> str:
        with mock.patch.object(runtime.os, "execve", side_effect=AssertionError("exec reached")):
            with self.assertRaises(RuntimeError) as caught:
                runtime.run_mcf()
        message = str(caught.exception)
        self.assertIn(fragment, message)
        for value in (*STATIC_CREDENTIALS.values(), KEY_CANARY, SCOPE, CONNECTION, MARKETPLACE):
            self.assertNotIn(value, message)
        return message

    def refuse_exactly(self, config: dict[str, str], credentials: dict[str, str], expected: str) -> None:
        self.write(config, credentials)
        self.assertEqual(self.refuse(expected), expected)


class McfMappingTests(McfCase):
    def test_mapping_and_keys_are_exact(self) -> None:
        self.assertEqual(runtime.MCF_CREDENTIALS, {
            "database-url": "DATABASE_URL",
            "spapi-lwa-client-id": "SP_API_LWA_CLIENT_ID",
            "spapi-lwa-client-secret-value": "SP_API_LWA_CLIENT_SECRET",
        })
        self.assertEqual(runtime.MCF_ENV_KEYS, frozenset({
            "OPENSPELL_MCF_PREVIEW_ENABLED", "OPENSPELL_MCF_DISPATCH_ENABLED", "OPENSPELL_MCF_SCOPE",
            "OPENSPELL_MCF_POLL_INTERVAL_MS", "WORKER_ID",
        }))
        # The send keys are the mcf unit's alone: worker.json cannot carry them.
        self.assertEqual(runtime.MCF_ENV_KEYS & runtime.WORKER_ENV_KEYS, {"WORKER_ID"})
        self.assertFalse(runtime.MCF_ENV_KEYS & (set(runtime.MCF_CREDENTIALS.values())
                                                 | set(runtime.AMAZON_CONNECTION_CREDENTIALS.values())))
        # No Ads credential and no webhook in the mcf mapping.
        self.assertFalse(set(runtime.MCF_CREDENTIALS) & (set(runtime.AMAZON_CREDENTIALS)
                                                         | set(runtime.WORKER_OPTIONAL_CREDENTIALS)))
        self.assertEqual(runtime.MCF_CONFIG.name, "mcf.json")

    def test_flags_off_passes_exactly_the_mcf_environment(self) -> None:
        self.write(OFF_CONFIG, {"database-url": DATABASE})
        launched, lines = self.launch()
        self.assertEqual(launched.path, "/fixture/node")
        self.assertEqual(launched.argv, [
            "/fixture/node", str(self.release / "app/node_modules/tsx/dist/cli.mjs"), "src/mcf-main.ts",
        ])
        self.assertEqual(Path(os.getcwd()).resolve(), (self.release / "app").resolve())
        self.assertEqual(set(launched.env), {
            "PATH", "HOME", "NODE_ENV", "DATABASE_URL", "OPENSPELL_WORKER_REVISION", "CREDENTIALS_DIRECTORY",
            *OFF_CONFIG,
        })
        self.assertEqual(launched.env["HOME"], STATE)
        self.assertEqual(launched.env["CREDENTIALS_DIRECTORY"], str(self.credentials))
        self.assertEqual(launched.env["OPENSPELL_WORKER_REVISION"], REVISION)
        self.assertNotIn("NODE_OPTIONS", launched.env)
        self.assertEqual(lines, [{
            "event": "wizard_ads_runtime_start", "mode": "mcf", "revision": REVISION,
            "spapiConnectionLoop": "disabled", "mcfPreview": "disabled", "mcfDispatch": "disabled",
            "mcfScopeEntries": 0, "mcfRecipientKeys": 0,
        }])

    def test_flags_on_passes_scope_lwa_and_the_directory_but_never_the_key(self) -> None:
        self.write(ON_CONFIG, {**STATIC_CREDENTIALS, KEY_NAME: KEY_CANARY})
        # Unreadable: the mode lists the key's name and must never open it.
        (self.credentials / KEY_NAME).chmod(0)
        launched, lines = self.launch()
        self.assertEqual(set(launched.env), {
            "PATH", "HOME", "NODE_ENV", "DATABASE_URL", "OPENSPELL_WORKER_REVISION", "CREDENTIALS_DIRECTORY",
            "SP_API_LWA_CLIENT_ID", "SP_API_LWA_CLIENT_SECRET", *ON_CONFIG,
        })
        self.assertEqual(launched.env["SP_API_LWA_CLIENT_ID"], CLIENT_ID)
        self.assertEqual(launched.env["SP_API_LWA_CLIENT_SECRET"], CLIENT_SECRET)
        self.assertEqual(launched.env["OPENSPELL_MCF_SCOPE"], SCOPE)
        self.assertEqual(launched.env["HOME"], STATE)
        self.assertNotIn("NODE_OPTIONS", launched.env)
        self.assertFalse(any(KEY_CANARY in value for value in launched.env.values()))
        self.assertFalse(any(KEY_NAME in key or KEY_NAME in value for key, value in launched.env.items()))
        rendered = json.dumps(lines)
        for value in (*STATIC_CREDENTIALS.values(), KEY_CANARY, SCOPE, CONNECTION, MARKETPLACE):
            self.assertNotIn(value, rendered)
        self.assertEqual(lines[0]["mcfPreview"], "enabled")
        self.assertEqual(lines[0]["mcfDispatch"], "enabled")
        self.assertEqual(lines[0]["mcfScopeEntries"], 1)
        self.assertEqual(lines[0]["mcfRecipientKeys"], 1)

    def test_optional_settings_pass_through_and_both_state_paths_are_accepted(self) -> None:
        config = {**ON_CONFIG, "OPENSPELL_MCF_POLL_INTERVAL_MS": "5000", "WORKER_ID": "wizard-ads-mcf"}
        launched_count = 0
        for state in runtime.MCF_STATE_DIRECTORIES:
            with self.subTest(state=state), mock.patch.dict(os.environ, {"STATE_DIRECTORY": state}):
                self.write(config, {**STATIC_CREDENTIALS, KEY_NAME: KEY_CANARY})
                launched, _ = self.launch()
                self.assertEqual(launched.env["HOME"], state)
                self.assertEqual(launched.env["OPENSPELL_MCF_POLL_INTERVAL_MS"], "5000")
                self.assertEqual(launched.env["WORKER_ID"], "wizard-ads-mcf")
                launched_count += 1
        self.assertEqual(launched_count, 2)

    def test_scope_with_flags_off_keeps_settlement_reads(self) -> None:
        self.write({**OFF_CONFIG, "OPENSPELL_MCF_SCOPE": SCOPE}, STATIC_CREDENTIALS)
        launched, lines = self.launch()
        self.assertEqual(launched.env["OPENSPELL_MCF_SCOPE"], SCOPE)
        self.assertEqual(launched.env["SP_API_LWA_CLIENT_SECRET"], CLIENT_SECRET)
        self.assertEqual((lines[0]["mcfPreview"], lines[0]["mcfDispatch"]), ("disabled", "disabled"))

    def test_mode_never_reads_worker_json(self) -> None:
        self.write(OFF_CONFIG, {"database-url": DATABASE})
        with mock.patch.object(runtime, "public_config", side_effect=AssertionError("worker.json read")):
            launched, _ = self.launch()
        self.assertEqual(launched.argv[-1], "src/mcf-main.ts")

    def test_mode_is_dispatched(self) -> None:
        with mock.patch.object(runtime, "run_mcf") as run, \
                mock.patch("sys.argv", ["credential_runtime.py", "mcf"]), \
                mock.patch.object(runtime.os, "umask"):
            runtime.main()
        run.assert_called_once_with()


class McfConfigRefusalTests(McfCase):
    def test_general_and_ads_keys_are_refused_by_name(self) -> None:
        general = sorted((runtime.WORKER_ENV_KEYS - {"WORKER_ID"}) | {"OPENSPELL_MCF_ALERT_WEBHOOK_URL"})
        self.assertIn("WORKER_JOB_TYPES", general)
        self.assertIn("OPENSPELL_AMAZON_CONNECTIONS_ENABLED", general)
        self.assertIn("OPENSPELL_MCF_OBSERVE_ENABLED", general)
        self.assertIn("WIZARD_ADS_APP_URL", general)
        refused = 0
        for key in general:
            with self.subTest(key=key):
                self.refuse_exactly({**OFF_CONFIG, key: "1"}, {"database-url": DATABASE},
                                    f"{key} belongs to the general worker, never the MCF unit's configuration")
                refused += 1
        self.assertEqual(refused, len(general))

    def test_credential_and_process_variables_are_refused(self) -> None:
        names = ("DATABASE_URL", "SP_API_LWA_CLIENT_ID", "SP_API_LWA_CLIENT_SECRET", "LWA_CLIENT_ID",
                 "LWA_CLIENT_SECRET", "CREDENTIALS_DIRECTORY", "HOME", "PATH", "NODE_OPTIONS",
                 "OPENSPELL_WORKER_REVISION", "STATE_DIRECTORY", "OPENSPELL_MCF_RECIPIENT_PUBLIC_KEY",
                 "OPENSPELL_MCF_" + "UNLISTED_FIXTURE")
        refused = 0
        for name in names:
            with self.subTest(name=name):
                self.refuse_exactly({**OFF_CONFIG, name: "x"}, {"database-url": DATABASE},
                                    "MCF configuration contains unsupported keys")
                refused += 1
        self.assertEqual(refused, len(names))

    def test_template_is_refused_until_filled(self) -> None:
        template = json.loads((HERE / "wizard-ads-mcf.TEMPLATE.json").read_text())
        self.assertEqual(set(template), set(ON_CONFIG))
        self.assertEqual((template["OPENSPELL_MCF_PREVIEW_ENABLED"], template["OPENSPELL_MCF_DISPATCH_ENABLED"]),
                         ("0", "0"))
        self.refuse_exactly(template, STATIC_CREDENTIALS, "MCF configuration still contains a template placeholder")

    def test_missing_or_malformed_configuration_is_refused(self) -> None:
        self.write(OFF_CONFIG, {"database-url": DATABASE})
        self.config.unlink()
        self.assertEqual(self.refuse("MCF configuration is unavailable"), "MCF configuration is unavailable")
        for text in ("not json", "[]", json.dumps({"OPENSPELL_MCF_PREVIEW_ENABLED": 0})):
            with self.subTest(text=text):
                self.config.write_text(text)
                self.refuse("MCF configuration")

    def test_flag_values_are_exact(self) -> None:
        values = ("", " ", "true", "yes", "on", "2", "01", " 1", "1 ", "1\n", "١")
        refused = 0
        for gate in ("OPENSPELL_MCF_PREVIEW_ENABLED", "OPENSPELL_MCF_DISPATCH_ENABLED"):
            for value in values:
                with self.subTest(gate=gate, value=value):
                    self.refuse_exactly({**ON_CONFIG, gate: value}, {**STATIC_CREDENTIALS, KEY_NAME: KEY_CANARY},
                                        FLAG_REFUSAL.format(gate))
                    refused += 1
        self.assertEqual(refused, 2 * len(values))

    def test_scope_shape_is_exact(self) -> None:
        upper = CONNECTION.upper() + ":" + MARKETPLACE
        values = ("", " ", SCOPE + ",", "," + SCOPE, f"{SCOPE},{SCOPE}", f" {SCOPE}", f"{SCOPE} ",
                  f"{SCOPE}, {SCOPE[:-1]}2", upper, f"{CONNECTION}:{MARKETPLACE.lower()}",
                  f"{CONNECTION}:SHORT", f"{CONNECTION}:{MARKETPLACE}X{'Y' * 8}", CONNECTION, MARKETPLACE,
                  f"{CONNECTION}:{MARKETPLACE};{SCOPE}", ",".join(f"{CONNECTION[:-3]}{i:03d}:{MARKETPLACE}"
                                                                   for i in range(51)))
        refused = 0
        for value in values:
            with self.subTest(value=value[:80]):
                self.refuse_exactly({**ON_CONFIG, "OPENSPELL_MCF_SCOPE": value},
                                    {**STATIC_CREDENTIALS, KEY_NAME: KEY_CANARY}, SCOPE_REFUSAL)
                refused += 1
        self.assertEqual(refused, len(values))
        fifty = ",".join(f"{CONNECTION[:-3]}{i:03d}:{MARKETPLACE}" for i in range(50))
        self.write({**ON_CONFIG, "OPENSPELL_MCF_SCOPE": fifty}, {**STATIC_CREDENTIALS, KEY_NAME: KEY_CANARY})
        launched, lines = self.launch()
        self.assertEqual(lines[0]["mcfScopeEntries"], 50)

    def test_a_flag_without_scope_is_refused(self) -> None:
        refused = 0
        for gate in ("OPENSPELL_MCF_PREVIEW_ENABLED", "OPENSPELL_MCF_DISPATCH_ENABLED"):
            with self.subTest(gate=gate):
                self.refuse_exactly({**OFF_CONFIG, gate: "1"}, {**STATIC_CREDENTIALS, KEY_NAME: KEY_CANARY},
                                    SCOPE_REQUIRED)
                refused += 1
        self.assertEqual(refused, 2)

    def test_poll_interval_and_worker_id_are_exact(self) -> None:
        intervals = ("", "999", "60001", "0", "05000", "+5000", "5000.0", " 5000", "5e3", "٥000")
        for value in intervals:
            with self.subTest(interval=value):
                self.refuse_exactly({**OFF_CONFIG, "OPENSPELL_MCF_POLL_INTERVAL_MS": value},
                                    {"database-url": DATABASE}, INTERVAL_REFUSAL)
        for value in ("1000", "60000"):
            with self.subTest(interval=value):
                self.write({**OFF_CONFIG, "OPENSPELL_MCF_POLL_INTERVAL_MS": value}, {"database-url": DATABASE})
                launched, _ = self.launch()
                self.assertEqual(launched.env["OPENSPELL_MCF_POLL_INTERVAL_MS"], value)
        worker_ids = ("", "two words", "x" * 71, "id/with/slash", "é")
        for value in worker_ids:
            with self.subTest(worker_id=value):
                self.refuse_exactly({**OFF_CONFIG, "WORKER_ID": value}, {"database-url": DATABASE}, WORKER_ID_REFUSAL)


class McfCredentialRefusalTests(McfCase):
    def test_a_flag_without_a_recipient_key_is_refused(self) -> None:
        refused = 0
        for gate in ("OPENSPELL_MCF_PREVIEW_ENABLED", "OPENSPELL_MCF_DISPATCH_ENABLED"):
            with self.subTest(gate=gate):
                self.refuse_exactly({**OFF_CONFIG, gate: "1", "OPENSPELL_MCF_SCOPE": SCOPE},
                                    STATIC_CREDENTIALS, KEY_REQUIRED)
                refused += 1
        self.assertEqual(refused, 2)

    def test_scope_requires_both_lwa_credentials(self) -> None:
        cases = ({"database-url": DATABASE},
                 {"database-url": DATABASE, "spapi-lwa-client-id": CLIENT_ID},
                 {"database-url": DATABASE, "spapi-lwa-client-secret-value": CLIENT_SECRET})
        refused = 0
        for credentials in cases:
            with self.subTest(credentials=sorted(credentials)):
                self.refuse_exactly({**OFF_CONFIG, "OPENSPELL_MCF_SCOPE": SCOPE}, credentials, LWA_REQUIRED)
                refused += 1
        self.assertEqual(refused, len(cases))

    def test_credentials_the_mode_does_not_use_are_refused(self) -> None:
        extras = ("ads-lwa-client-id", "ads-lwa-client-secret-value", "mcf-alert-webhook", "wizard-ads-mcp-token",
                  "mcf-recipient-0BADC0DE", "mcf-recipient-0badc0d", "mcf-recipient-0badc0de0", "mcf-recipient-")
        refused = 0
        for extra in extras:
            with self.subTest(extra=extra):
                self.refuse_exactly(OFF_CONFIG, {"database-url": DATABASE, extra: "synthetic"},
                                    f"wizard-ads-mcf.service loads a credential the mcf mode does not use: {extra}")
                refused += 1
        self.assertEqual(refused, len(extras))

    def test_database_and_lwa_values_are_validated(self) -> None:
        self.refuse_exactly(OFF_CONFIG, {"database-url": "mysql://synthetic"}, "1Password database credential is invalid")
        self.write({**OFF_CONFIG, "OPENSPELL_MCF_SCOPE": SCOPE},
                   {**STATIC_CREDENTIALS, "spapi-lwa-client-secret-value": "two words"})
        self.refuse("SP-API credential is invalid: spapi-lwa-client-secret-value")
        self.write(OFF_CONFIG, {})
        self.refuse("systemd runtime credential is unavailable: database-url")

    def test_runs_only_inside_its_unit(self) -> None:
        self.write(OFF_CONFIG, {"database-url": DATABASE})
        for state in (None, "", "/var/lib/wizard-ads", "/var/lib/wizard-ads-mcf/", "/tmp"):
            with self.subTest(state=state):
                environment = {k: v for k, v in os.environ.items() if k != "STATE_DIRECTORY"}
                if state is not None:
                    environment["STATE_DIRECTORY"] = state
                with mock.patch.dict(os.environ, environment, clear=True):
                    self.assertEqual(self.refuse(UNIT_ONLY), UNIT_ONLY)
        for directory in (None, "", "relative/credentials", str(self.credentials / "missing")):
            with self.subTest(directory=directory):
                environment = {k: v for k, v in os.environ.items() if k != "CREDENTIALS_DIRECTORY"}
                if directory is not None:
                    environment["CREDENTIALS_DIRECTORY"] = directory
                with mock.patch.dict(os.environ, environment, clear=True):
                    self.refuse("the mcf mode runs only under systemd with its credentials directory")

    def test_missing_entry_or_revision_is_refused(self) -> None:
        self.write(OFF_CONFIG, {"database-url": DATABASE})
        (self.release / "app/src/mcf-main.ts").unlink()
        self.refuse("deployed worker runtime is unavailable")
        (self.release / "REVISION").write_text("abc123\n")
        self.refuse("revision is invalid")


class OtherModesRefuseMcfKeysTests(McfCase):
    """The general, SP-API and Ads modes refuse the send gate and every recipient key."""

    def test_worker_json_refuses_each_mcf_unit_key_by_name(self) -> None:
        base = {"WORKER_ID": "fixture-worker",
                "WORKER_JOB_TYPES": ",".join(sorted(runtime.GENERAL_WORKER_JOB_TYPES))}
        keys = sorted(runtime.MCF_UNIT_ONLY_KEYS)
        self.assertEqual(len(keys), 4)
        refused = 0
        for key in keys:
            for run in (runtime.run_worker, runtime.run_spapi_connections, runtime.run_amazon_connections):
                with self.subTest(key=key, mode=run.__name__), \
                        mock.patch.object(runtime, "MCF_CONFIG", Path("/etc/wizard-ads-mcf/mcf.json")):
                    self.worker_config.write_text(json.dumps({**base, key: "0"}))
                    with mock.patch.object(runtime.os, "execve", side_effect=AssertionError("exec reached")):
                        with self.assertRaises(RuntimeError) as caught:
                            run()
                    self.assertEqual(str(caught.exception),
                                     f"{key} belongs to the MCF unit's configuration (/etc/wizard-ads-mcf/mcf.json), "
                                     "never worker.json")
                    refused += 1
        self.assertEqual(refused, 3 * len(keys))


SANDBOX_STATE = "/var/lib/wizard-ads-mcf-sandbox"
SANDBOX_ENDPOINT = "https://sandbox.sellingpartnerapi-na.amazon.com"
ORG = "0f0e0d0c-0b0a-4908-8706-" + "0504030201aa"
SANDBOX_RECIPIENT = {"name": "Zephyrine " + "Quartzwell", "addressLine1": "77 Bramble" + "holt Lane", "city": "Vellum" + "ford",
                     "stateOrRegion": "WA", "postalCode": "98001", "countryCode": "US"}
SANDBOX_CONFIG = {"endpoint": SANDBOX_ENDPOINT, "orgId": ORG, "scope": SCOPE, "sellerSku": "SYNTH-SKU-0001",
                  "recipient": SANDBOX_RECIPIENT}
# Values long enough to be unambiguous in a scan ("WA" and "US" would match variable names).
SANDBOX_VALUES = (ORG, SCOPE, CONNECTION, MARKETPLACE, "SYNTH-SKU-0001",
                  *(value for value in SANDBOX_RECIPIENT.values() if len(value) > 2))
SANDBOX_UNIT_ONLY = ("the mcf-sandbox mode runs only in wizard-ads-mcf-sandbox.service "
                     "(StateDirectory=wizard-ads-mcf-sandbox)")
ENDPOINT_REFUSAL = f"the mcf-sandbox mode calls only the NA SP-API sandbox endpoint ({SANDBOX_ENDPOINT})"
SANDBOX_UNIT = HERE / "wizard-ads-mcf-sandbox.service"


class McfSandboxCase(McfCase):
    def setUp(self) -> None:
        super().setUp()
        (self.release / "app/src/mcf-sandbox-cli.ts").write_text("")
        self.sandbox_config = Path(self.tmp.name) / "mcf-sandbox.json"
        patcher = mock.patch.object(runtime, "MCF_SANDBOX_CONFIG", self.sandbox_config)
        patcher.start()
        self.addCleanup(patcher.stop)
        patcher = mock.patch.dict(os.environ, {"STATE_DIRECTORY": SANDBOX_STATE})
        patcher.start()
        self.addCleanup(patcher.stop)

    def write_sandbox(self, config: object, credentials: dict[str, str]) -> None:
        self.write(OFF_CONFIG, credentials)
        self.sandbox_config.write_text(config if isinstance(config, str) else json.dumps(config))

    def launch_sandbox(self) -> tuple[Exec, list[dict[str, object]], int]:
        calls = []

        def execve(path: str, argv: list[str], env: dict[str, str]) -> None:
            calls.append(path)
            raise Exec(path, argv, env)
        output = io.StringIO()
        with mock.patch.object(runtime.os, "execve", execve), redirect_stdout(output), \
                mock.patch.object(runtime, "run_mcf", side_effect=AssertionError("mcf mode reached")):
            with self.assertRaises(Exec) as caught:
                runtime.run_mcf_sandbox()
        lines = [json.loads(line) for line in output.getvalue().splitlines()]
        return caught.exception, lines, len(calls)

    def refuse_sandbox(self, config: object, credentials: dict[str, str], expected: str, exact: bool = True) -> str:
        self.write_sandbox(config, credentials)
        with mock.patch.object(runtime.os, "execve", side_effect=AssertionError("exec reached")):
            with self.assertRaises(RuntimeError) as caught:
                runtime.run_mcf_sandbox()
        message = str(caught.exception)
        if exact:
            self.assertEqual(message, expected)
        else:
            self.assertIn(expected, message)
        for value in (*STATIC_CREDENTIALS.values(), KEY_CANARY, *SANDBOX_VALUES):
            if value not in expected:
                self.assertNotIn(value, message)
        return message


class McfSandboxModeTests(McfSandboxCase):
    def test_mapping_and_keys_are_exact(self) -> None:
        self.assertEqual(runtime.MCF_SANDBOX_CREDENTIALS, runtime.MCF_CREDENTIALS)
        self.assertEqual(runtime.MCF_SANDBOX_KEYS, frozenset({"endpoint", "orgId", "scope", "sellerSku", "recipient"}))
        self.assertEqual(runtime.MCF_SANDBOX_ENDPOINT, SANDBOX_ENDPOINT)
        self.assertEqual(str(runtime.MCF_SANDBOX_CONFIG.name), "mcf-sandbox.json")
        with mock.patch.object(runtime, "MCF_SANDBOX_CONFIG", Path("/etc/wizard-ads/mcf-sandbox.json")):
            self.assertEqual(str(runtime.MCF_SANDBOX_CONFIG), "/etc/wizard-ads/mcf-sandbox.json")
        self.assertEqual(runtime.MCF_SANDBOX_STATE_DIRECTORIES,
                         ("/var/lib/wizard-ads-mcf-sandbox", "/var/lib/private/wizard-ads-mcf-sandbox"))
        # No configuration key can become an environment variable, and none is an MCF unit or worker key.
        self.assertFalse(runtime.MCF_SANDBOX_KEYS & (runtime.MCF_ENV_KEYS | runtime.WORKER_ENV_KEYS))

    def test_execs_the_cli_once_with_exactly_its_environment(self) -> None:
        launched_count = 0
        for state in runtime.MCF_SANDBOX_STATE_DIRECTORIES:
            with self.subTest(state=state), mock.patch.dict(os.environ, {"STATE_DIRECTORY": state}):
                self.write_sandbox(SANDBOX_CONFIG, STATIC_CREDENTIALS)
                launched, lines, execs = self.launch_sandbox()
                self.assertEqual(execs, 1)
                self.assertEqual(launched.path, "/fixture/node")
                self.assertEqual(launched.argv, [
                    "/fixture/node", str(self.release / "app/node_modules/tsx/dist/cli.mjs"), "src/mcf-sandbox-cli.ts",
                ])
                self.assertEqual(set(launched.env), {
                    "PATH", "HOME", "NODE_ENV", "DATABASE_URL", "OPENSPELL_WORKER_REVISION", "SP_API_LWA_CLIENT_ID",
                    "SP_API_LWA_CLIENT_SECRET",
                })
                self.assertEqual(launched.env["HOME"], state)
                self.assertEqual(launched.env["DATABASE_URL"], DATABASE)
                self.assertEqual(launched.env["SP_API_LWA_CLIENT_SECRET"], CLIENT_SECRET)
                rendered_env = json.dumps(launched.env)
                for value in SANDBOX_VALUES:
                    self.assertNotIn(value, rendered_env)
                self.assertEqual(lines, [{
                    "event": "wizard_ads_runtime_start", "mode": "mcf-sandbox", "revision": REVISION,
                    "spapiConnectionLoop": "disabled", "mcfSandboxHost": "sandbox.sellingpartnerapi-na.amazon.com",
                }])
                launched_count += 1
        self.assertEqual(launched_count, 2)

    def test_mode_is_dispatched(self) -> None:
        with mock.patch.object(runtime, "run_mcf_sandbox") as run, mock.patch.object(runtime, "run_mcf") as mcf, \
                mock.patch("sys.argv", ["credential_runtime.py", "mcf-sandbox"]), \
                mock.patch.object(runtime.os, "umask"):
            runtime.main()
        run.assert_called_once_with()
        mcf.assert_not_called()

    def test_refuses_every_endpoint_but_the_na_sandbox(self) -> None:
        endpoints = ("https://sellingpartnerapi-na.amazon.com", "https://sandbox.sellingpartnerapi-eu.amazon.com",
                     "https://sandbox.sellingpartnerapi-fe.amazon.com", "http://sandbox.sellingpartnerapi-na.amazon.com",
                     SANDBOX_ENDPOINT + "/", SANDBOX_ENDPOINT.upper(), " " + SANDBOX_ENDPOINT, "", None, 1)
        refused = 0
        for endpoint in endpoints:
            with self.subTest(endpoint=endpoint):
                self.refuse_sandbox({**SANDBOX_CONFIG, "endpoint": endpoint}, STATIC_CREDENTIALS, ENDPOINT_REFUSAL)
                refused += 1
        without = {key: value for key, value in SANDBOX_CONFIG.items() if key != "endpoint"}
        self.refuse_sandbox(without, STATIC_CREDENTIALS, ENDPOINT_REFUSAL)
        self.assertEqual(refused, len(endpoints))

    def test_refuses_worker_and_mcf_unit_keys_by_name(self) -> None:
        keys = sorted(runtime.MCF_ENV_KEYS | runtime.WORKER_ENV_KEYS | {"OPENSPELL_MCF_ALERT_WEBHOOK_URL"})
        self.assertIn("OPENSPELL_MCF_DISPATCH_ENABLED", keys)
        self.assertIn("OPENSPELL_MCF_SCOPE", keys)
        self.assertIn("WORKER_JOB_TYPES", keys)
        refused = 0
        for key in keys:
            with self.subTest(key=key):
                self.refuse_sandbox({**SANDBOX_CONFIG, key: "1"}, STATIC_CREDENTIALS,
                                    f"{key} is a worker or MCF unit key, never the MCF sandbox configuration")
                refused += 1
        self.assertEqual(refused, len(keys))

    def test_refuses_any_other_shape(self) -> None:
        cases = [
            ({**SANDBOX_CONFIG, "DATABASE_URL": "x"}, "MCF sandbox configuration contains unsupported keys"),
            ({**SANDBOX_CONFIG, "credentialsDirectory": "x"}, "MCF sandbox configuration contains unsupported keys"),
            ({key: value for key, value in SANDBOX_CONFIG.items() if key != "recipient"},
             "MCF sandbox configuration must hold exactly endpoint, orgId, recipient, scope, sellerSku"),
            ({**SANDBOX_CONFIG, "recipient": {**SANDBOX_RECIPIENT, "phone": "5550100"}}, "MCF sandbox configuration is invalid"),
            ({**SANDBOX_CONFIG, "recipient": {}}, "MCF sandbox configuration is invalid"),
            ({**SANDBOX_CONFIG, "recipient": "inline"}, "MCF sandbox configuration is invalid"),
            ({**SANDBOX_CONFIG, "sellerSku": 7}, "MCF sandbox configuration is invalid"),
            ({**SANDBOX_CONFIG, "orgId": "<org-uuid>"}, "MCF sandbox configuration still contains a template placeholder"),
            ({**SANDBOX_CONFIG, "recipient": {**SANDBOX_RECIPIENT, "city": "<city>"}},
             "MCF sandbox configuration still contains a template placeholder"),
            ({**SANDBOX_CONFIG, "orgId": ORG.upper()}, "MCF sandbox configuration needs a lower-case orgId and one "
             "<lower-case connection uuid>:<marketplace id> scope"),
            ({**SANDBOX_CONFIG, "scope": f"{SCOPE},{SCOPE}"}, "MCF sandbox configuration needs a lower-case orgId and one "
             "<lower-case connection uuid>:<marketplace id> scope"),
            ([], "MCF sandbox configuration is invalid"),
            ("not json", "MCF sandbox configuration is unavailable"),
        ]
        refused = 0
        for config, expected in cases:
            with self.subTest(expected=expected, config=str(config)[:60]):
                self.refuse_sandbox(config, STATIC_CREDENTIALS, expected)
                refused += 1
        self.assertEqual(refused, len(cases))
        self.write_sandbox(SANDBOX_CONFIG, STATIC_CREDENTIALS)
        self.sandbox_config.unlink()
        with self.assertRaises(RuntimeError) as caught:
            runtime.run_mcf_sandbox()
        self.assertEqual(str(caught.exception), "MCF sandbox configuration is unavailable")

    def test_template_is_refused_until_filled(self) -> None:
        template = json.loads((HERE / "wizard-ads-mcf-sandbox.TEMPLATE.json").read_text())
        self.assertEqual(set(template), set(runtime.MCF_SANDBOX_KEYS))
        self.assertEqual(template["endpoint"], SANDBOX_ENDPOINT)
        self.assertLessEqual(set(template["recipient"]), set(runtime.MCF_SANDBOX_RECIPIENT_KEYS))
        rendered = json.dumps(template)
        self.assertIsNone(re.search(r"[0-9a-f]{8}-[0-9a-f]{4}|postgres|[A-Z0-9]{10,}", rendered))
        self.refuse_sandbox(template, STATIC_CREDENTIALS, "MCF sandbox configuration still contains a template placeholder")

    def test_requires_exactly_the_mcf_units_three_credentials(self) -> None:
        missing = ({"database-url": DATABASE},
                   {"database-url": DATABASE, "spapi-lwa-client-id": CLIENT_ID},
                   {"database-url": DATABASE, "spapi-lwa-client-secret-value": CLIENT_SECRET})
        for credentials in missing:
            with self.subTest(credentials=sorted(credentials)):
                self.refuse_sandbox(SANDBOX_CONFIG, credentials, LWA_REQUIRED)
        self.refuse_sandbox(SANDBOX_CONFIG, {"spapi-lwa-client-id": CLIENT_ID, "spapi-lwa-client-secret-value": CLIENT_SECRET},
                            "systemd runtime credential is unavailable: database-url")
        extras = (KEY_NAME, "mcf-alert-webhook", "ads-lwa-client-id", "ads-lwa-client-secret-value", "wizard-ads-mcp-token")
        refused = 0
        for extra in extras:
            with self.subTest(extra=extra):
                self.refuse_sandbox(SANDBOX_CONFIG, {**STATIC_CREDENTIALS, extra: "synthetic"},
                                    "wizard-ads-mcf-sandbox.service loads a credential the mcf-sandbox mode does not use: "
                                    + extra)
                refused += 1
        self.assertEqual(refused, len(extras))

    def test_runs_only_inside_its_unit(self) -> None:
        self.write_sandbox(SANDBOX_CONFIG, STATIC_CREDENTIALS)
        for state in (None, "", STATE, "/var/lib/private/wizard-ads-mcf", "/var/lib/wizard-ads", SANDBOX_STATE + "/"):
            with self.subTest(state=state):
                environment = {k: v for k, v in os.environ.items() if k != "STATE_DIRECTORY"}
                if state is not None:
                    environment["STATE_DIRECTORY"] = state
                with mock.patch.dict(os.environ, environment, clear=True):
                    self.refuse_sandbox(SANDBOX_CONFIG, STATIC_CREDENTIALS, SANDBOX_UNIT_ONLY)
        for directory in (None, "", "relative/credentials"):
            with self.subTest(directory=directory):
                environment = {k: v for k, v in os.environ.items() if k != "CREDENTIALS_DIRECTORY"}
                if directory is not None:
                    environment["CREDENTIALS_DIRECTORY"] = directory
                with mock.patch.dict(os.environ, environment, clear=True):
                    self.refuse_sandbox(SANDBOX_CONFIG, STATIC_CREDENTIALS,
                                        "the mcf-sandbox mode runs only under systemd with its credentials directory")

    def test_missing_entry_is_refused(self) -> None:
        self.write_sandbox(SANDBOX_CONFIG, STATIC_CREDENTIALS)
        (self.release / "app/src/mcf-sandbox-cli.ts").unlink()
        self.refuse_sandbox(SANDBOX_CONFIG, STATIC_CREDENTIALS, "deployed worker runtime is unavailable")

    def test_the_mcf_mode_is_unchanged_by_a_sandbox_configuration(self) -> None:
        self.write_sandbox(SANDBOX_CONFIG, {"database-url": DATABASE})
        with mock.patch.dict(os.environ, {"STATE_DIRECTORY": STATE}):
            launched, _ = self.launch()
        self.assertEqual(launched.argv[-1], "src/mcf-main.ts")
        self.assertFalse(any(value in json.dumps(launched.env) for value in SANDBOX_VALUES))


class McfSandboxUnitTests(unittest.TestCase):
    """wizard-ads-mcf-sandbox.service runs its one run and exits; nothing restarts or re-runs it."""

    def directives(self) -> list[str]:
        return [line for line in SANDBOX_UNIT.read_text(encoding="utf-8").splitlines()
                if line.strip() and not line.startswith("#")]

    def test_unit_is_a_oneshot_that_never_restarts_or_starts_at_boot(self) -> None:
        lines = self.directives()
        self.assertEqual(lines[0], "[Unit]")
        self.assertEqual([line for line in lines if line.startswith("[")], ["[Unit]", "[Service]"])
        self.assertIn("Type=oneshot", lines)
        self.assertEqual([line for line in lines if line.startswith("Type=")], ["Type=oneshot"])
        for prefix in ("Restart", "RemainAfterExit", "WantedBy", "RequiredBy", "Alias", "OnCalendar", "Also"):
            self.assertEqual([line for line in lines if line.startswith(prefix)], [], prefix)
        self.assertEqual([line for line in lines if line.startswith("ExecStart")],
                         ["ExecStart=/usr/local/lib/wizard-ads-runtime/worker-current/credential_runtime.py mcf-sandbox"])
        self.assertIn("DynamicUser=yes", lines)
        self.assertIn("StateDirectory=wizard-ads-mcf-sandbox", lines)
        self.assertIn("/var/lib/wizard-ads-mcf-sandbox", runtime.MCF_SANDBOX_STATE_DIRECTORIES)
        self.assertTrue(any(line.startswith("TimeoutStartSec=") for line in lines))

    def test_unit_loads_exactly_the_mcf_units_three_credentials(self) -> None:
        lines = self.directives()
        names = sorted(line.split("=", 1)[1].split(":", 1)[0] for line in lines if line.startswith("LoadCredentialEncrypted="))
        self.assertEqual(names, sorted(runtime.MCF_SANDBOX_CREDENTIALS))
        mcf_lines = (HERE / "wizard-ads-mcf.service").read_text(encoding="utf-8").splitlines()
        self.assertEqual([line for line in lines if line.startswith("LoadCredentialEncrypted=")],
                         [line for line in mcf_lines if line.startswith("LoadCredentialEncrypted=")])
        self.assertFalse(any("mcf-recipient" in line or "mcf-alert-webhook" in line or "ads-lwa" in line for line in lines))
        for prefix in ("User=", "Group=", "Environment", "ImportCredential", "SetCredential", "LoadCredential=", "Listen", "Sockets"):
            self.assertEqual([line for line in lines if line.startswith(prefix)], [], prefix)

    def test_unit_carries_the_mcf_units_hardening(self) -> None:
        lines = set(self.directives())
        names = ("DynamicUser", "UMask", "NoNewPrivileges", "Private[A-Za-z]+", "Protect[A-Za-z]+", "ProcSubset", "RemoveIPC",
                 "Restrict[A-Za-z]+", "LockPersonality", "SystemCallArchitectures", "CapabilityBoundingSet",
                 "AmbientCapabilities", "DevicePolicy", "TasksMax", "LimitNOFILE", "KillSignal", "StateDirectoryMode",
                 "LimitCORE", "CoredumpFilter", "MemorySwapMax")
        hardening = re.compile("^(" + "|".join(names) + ")=")
        mcf = [line for line in (HERE / "wizard-ads-mcf.service").read_text(encoding="utf-8").splitlines()
               if hardening.match(line)]
        self.assertEqual(len(mcf), 32)
        self.assertEqual([line for line in mcf if line not in lines], [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
