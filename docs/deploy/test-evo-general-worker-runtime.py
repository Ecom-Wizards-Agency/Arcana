#!/usr/bin/env python3
"""Credential mapping and mode tests for wizard-ads-credential-runtime.py (WP-326).

Runs against synthetic credentials in a temporary directory. os.execve is
replaced, so no worker, database or network is ever reached.
"""
from __future__ import annotations

import importlib.util
import io
import json
import os
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
# Synthetic values assembled at runtime; none is a real credential.
DATABASE = "postgres" + "ql://synthetic:" + "fixture@127.0.0.1:5432/postgres"
CLIENT_ID = "synthetic-lwa-" + "client-id-0001"
CLIENT_SECRET = "synthetic-lwa-" + "client-value-0002"
REDIRECT = "https://example.test/api/amazon/spapi/oauth/callback"
BASE_CONFIG = {
    "WORKER_ID": "fixture-worker",
    "WORKER_JOB_TYPES": "keepa.sync,rank.sync,economics.sync,sqp.categorize,recommendations.run",
    "WORKER_MAX_CONCURRENT_JOBS": "4",
    "PORT": "3777",
    "WIZARD_ADS_WEEKLY_RECOMMENDATION_RUNS": "1",
}
SPAPI_CONFIG = {
    "OPENSPELL_SPAPI_CONNECTIONS_ENABLED": "1",
    "SP_API_APPLICATION_ID": "synthetic-application",
    "SP_API_OAUTH_REGION": "EU",
    "SP_API_OAUTH_ALLOWED_REDIRECT_URIS": REDIRECT,
}
ALL_CREDENTIALS = {
    "database-url": DATABASE,
    "spapi-lwa-client-id": CLIENT_ID,
    "spapi-lwa-client-secret-value": CLIENT_SECRET,
}


class Exec(Exception):
    def __init__(self, path: str, argv: list[str], env: dict[str, str]) -> None:
        super().__init__(path)
        self.path, self.argv, self.env = path, argv, env


class RuntimeCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.release = root / "release"
        (self.release / "app/node_modules/tsx/dist").mkdir(parents=True)
        (self.release / "app/src").mkdir(parents=True)
        (self.release / "app/node_modules/tsx/dist/cli.mjs").write_text("")
        (self.release / "app/src/main.ts").write_text("")
        (self.release / "app/src/spapi-connections-cli.ts").write_text("")
        (self.release / "REVISION").write_text(REVISION + "\n")
        self.credentials = root / "credentials"
        self.credentials.mkdir()
        self.config = root / "worker.json"
        self.cwd = os.getcwd()
        for name, value in (
            ("RELEASE_ROOT", self.release),
            ("WORKER_CONFIG", self.config),
            ("NODE", "/fixture/node"),
        ):
            patcher = mock.patch.object(runtime, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = mock.patch.dict(os.environ, {"CREDENTIALS_DIRECTORY": str(self.credentials)})
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self) -> None:
        os.chdir(self.cwd)
        self.tmp.cleanup()

    def write(self, config: dict[str, str], credentials: dict[str, str]) -> None:
        self.config.write_text(json.dumps(config))
        for name, value in credentials.items():
            (self.credentials / name).write_text(value + "\n")

    def launch(self, run) -> tuple[Exec, list[dict[str, str]]]:
        def execve(path: str, argv: list[str], env: dict[str, str]) -> None:
            raise Exec(path, argv, env)
        output = io.StringIO()
        with mock.patch.object(runtime.os, "execve", execve), redirect_stdout(output):
            with self.assertRaises(Exec) as caught:
                run()
        lines = [json.loads(line) for line in output.getvalue().splitlines()]
        return caught.exception, lines

    def refuse(self, run, fragment: str) -> str:
        with mock.patch.object(runtime.os, "execve", side_effect=AssertionError("exec reached")):
            with self.assertRaises(RuntimeError) as caught:
                run()
        message = str(caught.exception)
        self.assertIn(fragment, message)
        for value in ALL_CREDENTIALS.values():
            self.assertNotIn(value, message)
        return message


class MappingTests(RuntimeCase):
    def test_mapping_is_exact_and_disjoint_from_public_keys(self) -> None:
        self.assertEqual(runtime.WORKER_CREDENTIALS, {
            "database-url": "DATABASE_URL",
            "spapi-lwa-client-id": "SP_API_LWA_CLIENT_ID",
            "spapi-lwa-client-secret-value": "SP_API_LWA_CLIENT_SECRET",
        })
        self.assertEqual(set(runtime.WORKER_CREDENTIALS.values()) & runtime.WORKER_ENV_KEYS, set())
        self.assertNotIn("OPENSPELL_WORKER_REVISION", runtime.WORKER_ENV_KEYS)
        self.assertFalse(any("KEEPA" in key for key in runtime.WORKER_ENV_KEYS))

    def test_worker_without_spapi_passes_database_only(self) -> None:
        self.write(BASE_CONFIG, {"database-url": DATABASE})
        launched, lines = self.launch(runtime.run_worker)
        self.assertEqual(launched.path, "/fixture/node")
        self.assertEqual(launched.argv, [
            "/fixture/node", str(self.release / "app/node_modules/tsx/dist/cli.mjs"), "src/main.ts",
        ])
        self.assertEqual(Path(os.getcwd()).resolve(), (self.release / "app").resolve())
        self.assertEqual(launched.env["DATABASE_URL"], DATABASE)
        self.assertEqual(launched.env["OPENSPELL_WORKER_REVISION"], REVISION)
        self.assertNotIn("SP_API_LWA_CLIENT_ID", launched.env)
        self.assertNotIn("SP_API_LWA_CLIENT_SECRET", launched.env)
        expected = {"PATH", "HOME", "NODE_ENV", "DATABASE_URL", "OPENSPELL_WORKER_REVISION", *BASE_CONFIG}
        self.assertEqual(set(launched.env), expected)
        self.assertEqual(lines, [{
            "event": "wizard_ads_runtime_start", "mode": "worker",
            "revision": REVISION, "spapiConnectionLoop": "disabled",
        }])

    def test_worker_maps_each_lwa_credential_to_its_variable(self) -> None:
        self.write({**BASE_CONFIG, **SPAPI_CONFIG}, ALL_CREDENTIALS)
        launched, lines = self.launch(runtime.run_worker)
        self.assertEqual(launched.env["SP_API_LWA_CLIENT_ID"], CLIENT_ID)
        self.assertEqual(launched.env["SP_API_LWA_CLIENT_SECRET"], CLIENT_SECRET)
        self.assertEqual(launched.env["DATABASE_URL"], DATABASE)
        for key, value in {**BASE_CONFIG, **SPAPI_CONFIG}.items():
            self.assertEqual(launched.env[key], value)
        expected = {
            "PATH", "HOME", "NODE_ENV", "OPENSPELL_WORKER_REVISION",
            *BASE_CONFIG, *SPAPI_CONFIG, *runtime.WORKER_CREDENTIALS.values(),
        }
        self.assertEqual(set(launched.env), expected)
        self.assertEqual(lines[0]["spapiConnectionLoop"], "enabled")
        for value in ALL_CREDENTIALS.values():
            self.assertNotIn(value, json.dumps(lines))

    def test_credentials_present_with_gate_off_are_still_mapped(self) -> None:
        self.write({**BASE_CONFIG, "OPENSPELL_SPAPI_CONNECTIONS_ENABLED": "0"}, ALL_CREDENTIALS)
        launched, lines = self.launch(runtime.run_worker)
        self.assertEqual(launched.env["SP_API_LWA_CLIENT_ID"], CLIENT_ID)
        self.assertEqual(lines[0]["spapiConnectionLoop"], "disabled")


class RefusalTests(RuntimeCase):
    def test_gate_on_without_credentials_is_refused(self) -> None:
        self.write({**BASE_CONFIG, **SPAPI_CONFIG}, {"database-url": DATABASE})
        self.refuse(runtime.run_worker, "must be supplied together")

    def test_one_lwa_credential_alone_is_refused(self) -> None:
        for present in ("spapi-lwa-client-id", "spapi-lwa-client-secret-value"):
            with self.subTest(present=present):
                for leftover in self.credentials.iterdir():
                    leftover.unlink()
                self.write(BASE_CONFIG, {"database-url": DATABASE, present: ALL_CREDENTIALS[present]})
                self.refuse(runtime.run_worker, "must be supplied together")

    def test_empty_or_whitespace_lwa_credential_is_refused(self) -> None:
        self.write(BASE_CONFIG, {**ALL_CREDENTIALS, "spapi-lwa-client-secret-value": ""})
        self.refuse(runtime.run_worker, "credential is empty: spapi-lwa-client-secret-value")
        self.write(BASE_CONFIG, {**ALL_CREDENTIALS, "spapi-lwa-client-id": "two words"})
        self.refuse(runtime.run_worker, "SP-API credential is invalid: spapi-lwa-client-id")

    def test_public_configuration_cannot_name_a_credential_variable(self) -> None:
        for variable in runtime.WORKER_CREDENTIALS.values():
            with self.subTest(variable=variable):
                self.write({**BASE_CONFIG, variable: "x"}, ALL_CREDENTIALS)
                self.refuse(runtime.run_worker, "unsupported keys")

    def test_public_configuration_cannot_set_the_revision(self) -> None:
        self.write({**BASE_CONFIG, "OPENSPELL_WORKER_REVISION": REVISION}, ALL_CREDENTIALS)
        self.refuse(runtime.run_worker, "unsupported keys")

    def test_template_placeholders_are_refused(self) -> None:
        template = json.loads((HERE / "wizard-ads-worker.TEMPLATE.json").read_text())
        self.write(template, ALL_CREDENTIALS)
        self.refuse(runtime.run_worker, "template placeholder")

    def test_gate_and_region_values_are_exact(self) -> None:
        self.write({**BASE_CONFIG, **SPAPI_CONFIG, "OPENSPELL_SPAPI_CONNECTIONS_ENABLED": "true"}, ALL_CREDENTIALS)
        self.refuse(runtime.run_worker, "must be 0 or 1")
        self.write({**BASE_CONFIG, **SPAPI_CONFIG, "SP_API_OAUTH_REGION": "US"}, ALL_CREDENTIALS)
        self.refuse(runtime.run_worker, "NA, EU or FE")

    def test_gate_on_requires_every_setting(self) -> None:
        for missing in runtime.SPAPI_SETTINGS:
            with self.subTest(missing=missing):
                config = {**BASE_CONFIG, **SPAPI_CONFIG}
                del config[missing]
                self.write(config, ALL_CREDENTIALS)
                self.refuse(runtime.run_worker, "SP-API connections require")

    def test_invalid_database_credential_is_refused(self) -> None:
        self.write(BASE_CONFIG, {"database-url": "mysql://synthetic"})
        self.refuse(runtime.run_worker, "database credential is invalid")

    def test_missing_or_malformed_revision_is_refused(self) -> None:
        self.write(BASE_CONFIG, {"database-url": DATABASE})
        (self.release / "REVISION").write_text("abc123\n")
        self.refuse(runtime.run_worker, "revision is invalid")
        (self.release / "REVISION").unlink()
        self.refuse(runtime.run_worker, "revision is unavailable")

    def test_missing_runtime_is_refused(self) -> None:
        self.write(BASE_CONFIG, {"database-url": DATABASE})
        (self.release / "app/node_modules/tsx/dist/cli.mjs").unlink()
        self.refuse(runtime.run_worker, "deployed worker runtime is unavailable")


class ConnectionOnlyTests(RuntimeCase):
    def test_passes_only_database_and_spapi_variables(self) -> None:
        self.write({**BASE_CONFIG, **SPAPI_CONFIG, "OPENSPELL_SPAPI_CONNECTIONS_ENABLED": "0"}, ALL_CREDENTIALS)
        launched, lines = self.launch(runtime.run_spapi_connections)
        self.assertEqual(launched.argv[-1], "src/spapi-connections-cli.ts")
        self.assertEqual(set(launched.env), {
            "PATH", "HOME", "NODE_ENV", "DATABASE_URL", "OPENSPELL_SPAPI_CONNECTIONS_ENABLED",
            "SP_API_LWA_CLIENT_ID", "SP_API_LWA_CLIENT_SECRET", *runtime.SPAPI_SETTINGS,
        })
        self.assertEqual(launched.env["OPENSPELL_SPAPI_CONNECTIONS_ENABLED"], "1")
        self.assertEqual(launched.env["SP_API_LWA_CLIENT_SECRET"], CLIENT_SECRET)
        self.assertFalse(any(key.startswith("WORKER_") for key in launched.env))
        self.assertNotIn("PORT", launched.env)
        self.assertEqual(lines[0]["mode"], "spapi-connections")

    def test_refused_while_the_general_worker_owns_the_loop(self) -> None:
        self.write({**BASE_CONFIG, **SPAPI_CONFIG}, ALL_CREDENTIALS)
        self.refuse(runtime.run_spapi_connections, "general worker owns the SP-API connection loop")

    def test_requires_credentials_and_settings(self) -> None:
        self.write({**BASE_CONFIG, **SPAPI_CONFIG, "OPENSPELL_SPAPI_CONNECTIONS_ENABLED": "0"},
                   {"database-url": DATABASE})
        self.refuse(runtime.run_spapi_connections, "must be supplied together")
        self.write(BASE_CONFIG, ALL_CREDENTIALS)
        self.refuse(runtime.run_spapi_connections, "SP-API connections require")

    def test_mode_is_dispatched(self) -> None:
        with mock.patch.object(runtime, "run_spapi_connections") as run, \
                mock.patch("sys.argv", ["credential_runtime.py", "spapi-connections"]), \
                mock.patch.object(runtime.os, "umask"):
            runtime.main()
        run.assert_called_once_with()


if __name__ == "__main__":
    unittest.main(verbosity=2)
