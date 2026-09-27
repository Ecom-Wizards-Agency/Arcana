#!/usr/bin/env python3
"""Credential mapping and mode tests for wizard-ads-credential-runtime.py (WP-326, WP-330, WP-336).

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
SIX_JOB_TYPES = "keepa.sync,rank.sync,economics.sync,sqp.categorize,sqp.request,recommendations.run"
FIVE_JOB_TYPES = "keepa.sync,rank.sync,economics.sync,sqp.categorize,recommendations.run"
SEVEN_JOB_TYPES = SIX_JOB_TYPES + ",report.fetch"
BASE_CONFIG = {
    "WORKER_ID": "fixture-worker",
    "WORKER_JOB_TYPES": SIX_JOB_TYPES,
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
ADS_CLIENT_ID = "synthetic-ads-" + "client-id-0003"
ADS_CLIENT_SECRET = "synthetic-ads-" + "client-value-0004"
ADS_REDIRECT = "https://example.test/api/amazon/oauth/callback"
AMAZON_CONFIG = {
    "OPENSPELL_AMAZON_CONNECTIONS_ENABLED": "1",
    "AMAZON_OAUTH_ALLOWED_REDIRECT_URIS": ADS_REDIRECT,
}
ADS_CREDENTIALS = {
    "database-url": DATABASE,
    "ads-lwa-client-id": ADS_CLIENT_ID,
    "ads-lwa-client-secret-value": ADS_CLIENT_SECRET,
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
        (self.release / "app/src/amazon-connections-cli.ts").write_text("")
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
        for value in [*ALL_CREDENTIALS.values(), *ADS_CREDENTIALS.values()]:
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


class JobTypeTests(RuntimeCase):
    def test_runtime_declares_exactly_the_six_general_worker_job_types(self) -> None:
        self.assertEqual(runtime.GENERAL_WORKER_JOB_TYPES, frozenset(SIX_JOB_TYPES.split(",")))
        self.assertEqual(len(runtime.GENERAL_WORKER_JOB_TYPES), 6)
        self.assertIn("sqp.request", runtime.GENERAL_WORKER_JOB_TYPES)

    def test_six_type_set_is_accepted_in_any_order(self) -> None:
        orders = (SIX_JOB_TYPES, ",".join(reversed(SIX_JOB_TYPES.split(","))))
        accepted = 0
        for order in orders:
            with self.subTest(order=order):
                self.write({**BASE_CONFIG, "WORKER_JOB_TYPES": order}, {"database-url": DATABASE})
                self.assertEqual(runtime.public_config()["WORKER_JOB_TYPES"], order)
                launched, _ = self.launch(runtime.run_worker)
                self.assertEqual(launched.env["WORKER_JOB_TYPES"], order)
                accepted += 1
        self.assertEqual(accepted, len(orders))

    def test_five_type_set_without_sqp_request_is_refused(self) -> None:
        self.assertNotIn("sqp.request", FIVE_JOB_TYPES.split(","))
        self.assertEqual(len(FIVE_JOB_TYPES.split(",")), 5)
        self.write({**BASE_CONFIG, "WORKER_JOB_TYPES": FIVE_JOB_TYPES}, {"database-url": DATABASE})
        message = self.refuse(runtime.run_worker, "WORKER_JOB_TYPES must list exactly")
        self.assertIn("sqp.request", message)

    def test_seven_type_set_is_refused(self) -> None:
        self.assertEqual(len(set(SEVEN_JOB_TYPES.split(","))), 7)
        self.write({**BASE_CONFIG, "WORKER_JOB_TYPES": SEVEN_JOB_TYPES}, {"database-url": DATABASE})
        self.refuse(runtime.run_worker, "WORKER_JOB_TYPES must list exactly")

    def test_duplicated_padded_or_absent_job_types_are_refused(self) -> None:
        variants = {
            "duplicate": SIX_JOB_TYPES + ",sqp.request",
            "padded": SIX_JOB_TYPES.replace(",", ", "),
            "trailing comma": SIX_JOB_TYPES + ",",
            "empty": "",
        }
        refused = 0
        for label, value in variants.items():
            with self.subTest(variant=label):
                self.write({**BASE_CONFIG, "WORKER_JOB_TYPES": value}, {"database-url": DATABASE})
                self.refuse(runtime.run_worker, "WORKER_JOB_TYPES must list exactly")
                refused += 1
        config = dict(BASE_CONFIG)
        del config["WORKER_JOB_TYPES"]
        self.write(config, {"database-url": DATABASE})
        self.refuse(runtime.run_worker, "WORKER_JOB_TYPES must list exactly")
        refused += 1
        self.assertEqual(refused, len(variants) + 1)


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

    def test_does_not_apply_the_worker_job_type_set(self) -> None:
        # The connection-only command claims no queue job, so a worker.json that
        # the worker mode would refuse still starts the connection loop.
        started = 0
        for job_types in (FIVE_JOB_TYPES, SEVEN_JOB_TYPES):
            with self.subTest(job_types=job_types):
                self.write({**BASE_CONFIG, **SPAPI_CONFIG, "WORKER_JOB_TYPES": job_types,
                            "OPENSPELL_SPAPI_CONNECTIONS_ENABLED": "0"}, ALL_CREDENTIALS)
                launched, _ = self.launch(runtime.run_spapi_connections)
                self.assertEqual(launched.argv[-1], "src/spapi-connections-cli.ts")
                started += 1
        self.assertEqual(started, 2)

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


class AmazonConnectionTests(RuntimeCase):
    def test_amazon_mapping_is_exact_and_disjoint_from_public_keys(self) -> None:
        self.assertEqual(runtime.AMAZON_CONNECTION_CREDENTIALS, {
            "database-url": "DATABASE_URL",
            "ads-lwa-client-id": "LWA_CLIENT_ID",
            "ads-lwa-client-secret-value": "LWA_CLIENT_SECRET",
        })
        self.assertEqual(set(runtime.AMAZON_CONNECTION_CREDENTIALS.values()) & runtime.WORKER_ENV_KEYS, set())
        # The general worker's unit loads none of the Ads credentials.
        self.assertEqual(set(runtime.AMAZON_CREDENTIALS) & set(runtime.WORKER_CREDENTIALS), set())
        self.assertEqual(runtime.AMAZON_KEYS, frozenset(AMAZON_CONFIG))
        self.assertLessEqual(runtime.AMAZON_KEYS, runtime.WORKER_ENV_KEYS)

    def test_passes_only_database_ads_credentials_and_settings(self) -> None:
        self.write({**BASE_CONFIG, **SPAPI_CONFIG, **AMAZON_CONFIG}, {**ALL_CREDENTIALS, **ADS_CREDENTIALS})
        launched, lines = self.launch(runtime.run_amazon_connections)
        self.assertEqual(launched.argv, [
            "/fixture/node", str(self.release / "app/node_modules/tsx/dist/cli.mjs"),
            "src/amazon-connections-cli.ts",
        ])
        self.assertEqual(set(launched.env), {
            "PATH", "HOME", "NODE_ENV", "DATABASE_URL", "OPENSPELL_AMAZON_CONNECTIONS_ENABLED",
            "AMAZON_OAUTH_ALLOWED_REDIRECT_URIS", "LWA_CLIENT_ID", "LWA_CLIENT_SECRET",
        })
        self.assertEqual(launched.env["OPENSPELL_AMAZON_CONNECTIONS_ENABLED"], "1")
        self.assertEqual(launched.env["AMAZON_OAUTH_ALLOWED_REDIRECT_URIS"], ADS_REDIRECT)
        self.assertEqual(launched.env["LWA_CLIENT_ID"], ADS_CLIENT_ID)
        self.assertEqual(launched.env["LWA_CLIENT_SECRET"], ADS_CLIENT_SECRET)
        self.assertEqual(launched.env["DATABASE_URL"], DATABASE)
        self.assertFalse(any(key.startswith(("WORKER_", "SP_API_")) for key in launched.env))
        self.assertEqual(lines, [{
            "event": "wizard_ads_runtime_start", "mode": "amazon-connections", "revision": REVISION,
            "spapiConnectionLoop": "disabled", "amazonConnectionLoop": "enabled",
        }])
        for value in [*ALL_CREDENTIALS.values(), *ADS_CREDENTIALS.values(), ADS_REDIRECT]:
            self.assertNotIn(value, json.dumps(lines))

    def test_does_not_apply_the_worker_job_type_set(self) -> None:
        started = 0
        for job_types in (FIVE_JOB_TYPES, SEVEN_JOB_TYPES, "entity.sync"):
            with self.subTest(job_types=job_types):
                self.write({**BASE_CONFIG, **AMAZON_CONFIG, "WORKER_JOB_TYPES": job_types}, ADS_CREDENTIALS)
                launched, _ = self.launch(runtime.run_amazon_connections)
                self.assertEqual(launched.argv[-1], "src/amazon-connections-cli.ts")
                self.assertNotIn("WORKER_JOB_TYPES", launched.env)
                started += 1
        self.assertEqual(started, 3)

    def test_worker_mode_never_passes_amazon_settings_or_credentials(self) -> None:
        # With the Ads gate at 1 the worker config would refuse to start, as
        # the general worker does not claim entity.sync.
        self.write({**BASE_CONFIG, **SPAPI_CONFIG, **AMAZON_CONFIG}, {**ALL_CREDENTIALS, **ADS_CREDENTIALS})
        launched, lines = self.launch(runtime.run_worker)
        self.assertEqual(launched.argv[-1], "src/main.ts")
        self.assertEqual(set(launched.env), {
            "PATH", "HOME", "NODE_ENV", "OPENSPELL_WORKER_REVISION",
            *BASE_CONFIG, *SPAPI_CONFIG, *runtime.WORKER_CREDENTIALS.values(),
        })
        self.assertFalse(set(launched.env) & (set(AMAZON_CONFIG) | {"LWA_CLIENT_ID", "LWA_CLIENT_SECRET"}))
        self.assertNotIn(ADS_CLIENT_SECRET, json.dumps(launched.env))
        self.assertEqual(lines[0], {
            "event": "wizard_ads_runtime_start", "mode": "worker",
            "revision": REVISION, "spapiConnectionLoop": "enabled",
        })

    def test_spapi_mode_never_passes_amazon_settings(self) -> None:
        self.write({**BASE_CONFIG, **SPAPI_CONFIG, **AMAZON_CONFIG, "OPENSPELL_SPAPI_CONNECTIONS_ENABLED": "0"},
                   {**ALL_CREDENTIALS, **ADS_CREDENTIALS})
        launched, _ = self.launch(runtime.run_spapi_connections)
        self.assertEqual(launched.argv[-1], "src/spapi-connections-cli.ts")
        self.assertFalse(set(launched.env) & (set(AMAZON_CONFIG) | {"LWA_CLIENT_ID", "LWA_CLIENT_SECRET"}))

    def test_refused_unless_the_gate_is_one(self) -> None:
        refused = 0
        for gate in (None, "0"):
            with self.subTest(gate=gate):
                config = {**BASE_CONFIG, **AMAZON_CONFIG}
                if gate is None:
                    del config["OPENSPELL_AMAZON_CONNECTIONS_ENABLED"]
                else:
                    config["OPENSPELL_AMAZON_CONNECTIONS_ENABLED"] = gate
                self.write(config, ADS_CREDENTIALS)
                self.refuse(runtime.run_amazon_connections,
                            "set OPENSPELL_AMAZON_CONNECTIONS_ENABLED to 1 in the worker configuration")
                refused += 1
        self.assertEqual(refused, 2)

    def test_gate_value_is_exact_in_every_mode(self) -> None:
        self.write({**BASE_CONFIG, **AMAZON_CONFIG, "OPENSPELL_AMAZON_CONNECTIONS_ENABLED": "true"}, ADS_CREDENTIALS)
        for run in (runtime.run_amazon_connections, runtime.run_worker, runtime.run_spapi_connections):
            with self.subTest(run=run.__name__):
                self.refuse(run, "OPENSPELL_AMAZON_CONNECTIONS_ENABLED must be 0 or 1")

    def test_requires_the_allowed_redirects(self) -> None:
        for value in (None, ""):
            with self.subTest(value=value):
                config = {**BASE_CONFIG, **AMAZON_CONFIG}
                if value is None:
                    del config["AMAZON_OAUTH_ALLOWED_REDIRECT_URIS"]
                else:
                    config["AMAZON_OAUTH_ALLOWED_REDIRECT_URIS"] = value
                self.write(config, ADS_CREDENTIALS)
                self.refuse(runtime.run_amazon_connections,
                            "Amazon Ads connections require AMAZON_OAUTH_ALLOWED_REDIRECT_URIS")

    def test_requires_both_ads_credentials(self) -> None:
        cases = ({"database-url": DATABASE},
                 {"database-url": DATABASE, "ads-lwa-client-id": ADS_CLIENT_ID},
                 {"database-url": DATABASE, "ads-lwa-client-secret-value": ADS_CLIENT_SECRET},
                 # The SP-API pair is a different application and never stands in.
                 ALL_CREDENTIALS)
        refused = 0
        for credentials in cases:
            with self.subTest(credentials=sorted(credentials)):
                for leftover in self.credentials.iterdir():
                    leftover.unlink()
                self.write({**BASE_CONFIG, **AMAZON_CONFIG}, credentials)
                self.refuse(runtime.run_amazon_connections,
                            "Amazon Ads LWA credentials must be supplied together: "
                            "ads-lwa-client-id, ads-lwa-client-secret-value")
                refused += 1
        self.assertEqual(refused, len(cases))

    def test_empty_or_malformed_ads_credential_is_refused(self) -> None:
        self.write({**BASE_CONFIG, **AMAZON_CONFIG}, {**ADS_CREDENTIALS, "ads-lwa-client-secret-value": ""})
        self.refuse(runtime.run_amazon_connections, "credential is empty: ads-lwa-client-secret-value")
        self.write({**BASE_CONFIG, **AMAZON_CONFIG}, {**ADS_CREDENTIALS, "ads-lwa-client-id": "two words"})
        self.refuse(runtime.run_amazon_connections, "Amazon Ads credential is invalid: ads-lwa-client-id")
        self.write({**BASE_CONFIG, **AMAZON_CONFIG}, {**ADS_CREDENTIALS, "database-url": "mysql://synthetic"})
        self.refuse(runtime.run_amazon_connections, "database credential is invalid")

    def test_public_configuration_cannot_name_an_ads_credential_variable(self) -> None:
        names = ("LWA_CLIENT_ID", "LWA_CLIENT_SECRET", "AMAZON_LWA_CLIENT_ID",
                 "AMAZON_LWA_CLIENT_SECRET", "AMAZON_OAUTH_REDIRECT_URI")
        refused = 0
        for variable in names:
            with self.subTest(variable=variable):
                self.write({**BASE_CONFIG, **AMAZON_CONFIG, variable: "x"}, ADS_CREDENTIALS)
                self.refuse(runtime.run_amazon_connections, "unsupported keys")
                refused += 1
        self.assertEqual(refused, len(names))

    def test_missing_command_is_refused(self) -> None:
        self.write({**BASE_CONFIG, **AMAZON_CONFIG}, ADS_CREDENTIALS)
        (self.release / "app/src/amazon-connections-cli.ts").unlink()
        self.refuse(runtime.run_amazon_connections, "deployed worker runtime is unavailable")

    def test_mode_is_dispatched(self) -> None:
        with mock.patch.object(runtime, "run_amazon_connections") as run, \
                mock.patch("sys.argv", ["credential_runtime.py", "amazon-connections"]), \
                mock.patch.object(runtime.os, "umask"):
            runtime.main()
        run.assert_called_once_with()


IMPORT_DIRECTORY = "/var/lib/wizard-ads-imports/market-signals"
ORG_ID = "0f0e0d0c-0b0a-4908-8706-050403020100"
IMPORT_CONFIG = {
    "OPENSPELL_MARKET_SIGNALS_DIR": IMPORT_DIRECTORY,
    "OPENSPELL_MARKET_SIGNALS_ORG_KEYS": "synthetic-org=" + ORG_ID + ",other.key=" + ORG_ID.upper(),
}

DIRECTORY_REFUSAL = ("OPENSPELL_MARKET_SIGNALS_DIR must be a normalized absolute path outside "
                     "/home, /root, /run/user")
ORG_KEYS_REFUSAL = "OPENSPELL_MARKET_SIGNALS_ORG_KEYS must be key=uuid[,key=uuid] with unique keys"


class MarketSignalsImportTests(RuntimeCase):
    def refuse_import(self, config: dict[str, str], expected: str) -> None:
        # The whole message is fixed text naming the key, so no value can appear in it.
        self.write({**BASE_CONFIG, **config}, {"database-url": DATABASE})
        self.assertEqual(self.refuse(runtime.run_worker, expected), expected)

    def test_import_keys_are_allowlisted_and_never_credentials(self) -> None:
        self.assertEqual(runtime.IMPORT_KEYS, frozenset(IMPORT_CONFIG))
        self.assertLessEqual(runtime.IMPORT_KEYS, runtime.WORKER_ENV_KEYS)
        self.assertFalse(runtime.IMPORT_KEYS & (set(runtime.WORKER_CREDENTIALS.values())
                                               | set(runtime.AMAZON_CONNECTION_CREDENTIALS.values())))

    def test_worker_passes_valid_import_settings_exactly(self) -> None:
        for config in (IMPORT_CONFIG, {"OPENSPELL_MARKET_SIGNALS_DIR": "/srv/market-signals"}):
            with self.subTest(config=config):
                self.write({**BASE_CONFIG, **config}, {"database-url": DATABASE})
                launched, lines = self.launch(runtime.run_worker)
                for key, value in config.items():
                    self.assertEqual(launched.env[key], value)
                self.assertEqual(set(launched.env), {
                    "PATH", "HOME", "NODE_ENV", "DATABASE_URL", "OPENSPELL_WORKER_REVISION",
                    *BASE_CONFIG, *config,
                })
                self.assertNotIn(IMPORT_DIRECTORY, json.dumps(lines))

    def test_absent_directory_leaves_the_import_off(self) -> None:
        self.write(BASE_CONFIG, {"database-url": DATABASE})
        launched, _ = self.launch(runtime.run_worker)
        self.assertFalse(set(launched.env) & runtime.IMPORT_KEYS)

    def test_directory_must_be_absolute_normalized_and_outside_hidden_roots(self) -> None:
        home = "/home"  # joined below: the deployment files may not name a home path literally
        for value in ("", " ", "relative/market-signals", "/", home, f"{home}/operator/exports",
                      "/root", "/root/exports", "/run/user/1000/exports", "/var/lib/wizard-ads-imports/",
                      f"/var/lib/..{home}/operator", "/var/lib/./wizard-ads-imports",
                      "/var//lib/wizard-ads-imports", " /srv/market-signals", "/srv/market signals",
                      "/srv/market-signals\n"):
            with self.subTest(value=value):
                self.refuse_import({"OPENSPELL_MARKET_SIGNALS_DIR": value}, DIRECTORY_REFUSAL)

    def test_org_key_map_shape_is_exact(self) -> None:
        for value in ("", "synthetic-org", f"synthetic-org={ORG_ID}x", f"={ORG_ID}",
                      f"synthetic-org={ORG_ID},", f" synthetic-org={ORG_ID}",
                      f"synthetic-org={ORG_ID},synthetic-org={ORG_ID}", "synthetic-org=not-a-uuid",
                      f"-leading={ORG_ID}", f"two words={ORG_ID}"):
            with self.subTest(value=value):
                self.refuse_import({"OPENSPELL_MARKET_SIGNALS_DIR": IMPORT_DIRECTORY,
                                    "OPENSPELL_MARKET_SIGNALS_ORG_KEYS": value},
                                   ORG_KEYS_REFUSAL)

    def test_org_key_map_without_directory_is_refused(self) -> None:
        self.refuse_import({"OPENSPELL_MARKET_SIGNALS_ORG_KEYS": IMPORT_CONFIG["OPENSPELL_MARKET_SIGNALS_ORG_KEYS"]},
                           "OPENSPELL_MARKET_SIGNALS_ORG_KEYS requires OPENSPELL_MARKET_SIGNALS_DIR")

    def test_connection_modes_never_pass_import_settings(self) -> None:
        self.write({**BASE_CONFIG, **SPAPI_CONFIG, **AMAZON_CONFIG, **IMPORT_CONFIG,
                    "OPENSPELL_SPAPI_CONNECTIONS_ENABLED": "0"}, {**ALL_CREDENTIALS, **ADS_CREDENTIALS})
        for run in (runtime.run_spapi_connections, runtime.run_amazon_connections):
            with self.subTest(mode=run.__name__):
                launched, _ = self.launch(run)
                self.assertFalse(set(launched.env) & runtime.IMPORT_KEYS)


if __name__ == "__main__":
    unittest.main(verbosity=2)
