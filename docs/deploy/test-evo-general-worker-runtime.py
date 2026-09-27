#!/usr/bin/env python3
"""Credential mapping and mode tests for wizard-ads-credential-runtime.py (WP-326, WP-330, WP-336, WP-338b, WP-338f).

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
# The set before WP-338b; the runtime now refuses it.
PRIOR_SIX_JOB_TYPES = "keepa.sync,rank.sync,economics.sync,sqp.categorize,sqp.request,recommendations.run"
# The general worker's exact claim surface since WP-338b.
SEVEN_JOB_TYPES = PRIOR_SIX_JOB_TYPES + ",mcf.observe"
WITHOUT_SQP_REQUEST = SEVEN_JOB_TYPES.replace("sqp.request,", "")
# keepa.sync's retirement is prepared, not applied: this set is refused today.
WITHOUT_KEEPA = SEVEN_JOB_TYPES.replace("keepa.sync,", "")
EIGHT_JOB_TYPES = SEVEN_JOB_TYPES + ",report.fetch"
BASE_CONFIG = {
    "WORKER_ID": "fixture-worker",
    "WORKER_JOB_TYPES": SEVEN_JOB_TYPES,
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
    def test_runtime_declares_exactly_the_seven_general_worker_job_types(self) -> None:
        self.assertEqual(runtime.GENERAL_WORKER_JOB_TYPES, frozenset(SEVEN_JOB_TYPES.split(",")))
        self.assertEqual(len(runtime.GENERAL_WORKER_JOB_TYPES), 7)
        self.assertIn("sqp.request", runtime.GENERAL_WORKER_JOB_TYPES)
        self.assertIn("mcf.observe", runtime.GENERAL_WORKER_JOB_TYPES)
        self.assertIn("keepa.sync", runtime.GENERAL_WORKER_JOB_TYPES)

    def test_seven_type_set_is_accepted_in_any_order(self) -> None:
        orders = (SEVEN_JOB_TYPES, ",".join(reversed(SEVEN_JOB_TYPES.split(","))))
        accepted = 0
        for order in orders:
            with self.subTest(order=order):
                self.write({**BASE_CONFIG, "WORKER_JOB_TYPES": order}, {"database-url": DATABASE})
                self.assertEqual(runtime.public_config()["WORKER_JOB_TYPES"], order)
                launched, _ = self.launch(runtime.run_worker)
                self.assertEqual(launched.env["WORKER_JOB_TYPES"], order)
                accepted += 1
        self.assertEqual(accepted, len(orders))

    def test_every_other_set_of_known_types_is_refused(self) -> None:
        sets = {
            # The live worker.json before the switch: the new runtime refuses it,
            # so the release switch and the job-type edit happen together.
            "prior six without mcf.observe": PRIOR_SIX_JOB_TYPES,
            "without sqp.request": WITHOUT_SQP_REQUEST,
            "without keepa.sync": WITHOUT_KEEPA,
            "with report.fetch": EIGHT_JOB_TYPES,
        }
        self.assertEqual(len(PRIOR_SIX_JOB_TYPES.split(",")), 6)
        self.assertEqual(len(WITHOUT_SQP_REQUEST.split(",")), 6)
        self.assertNotIn("sqp.request", WITHOUT_SQP_REQUEST.split(","))
        self.assertEqual(len(WITHOUT_KEEPA.split(",")), 6)
        self.assertNotIn("keepa.sync", WITHOUT_KEEPA.split(","))
        self.assertEqual(len(set(EIGHT_JOB_TYPES.split(","))), 8)
        refused = 0
        for label, job_types in sets.items():
            with self.subTest(set=label):
                self.write({**BASE_CONFIG, "WORKER_JOB_TYPES": job_types}, {"database-url": DATABASE})
                message = self.refuse(runtime.run_worker, "WORKER_JOB_TYPES must list exactly")
                self.assertTrue(message.endswith(",".join(sorted(SEVEN_JOB_TYPES.split(",")))))
                refused += 1
        self.assertEqual(refused, len(sets))

    def test_duplicated_padded_or_absent_job_types_are_refused(self) -> None:
        variants = {
            "duplicate": SEVEN_JOB_TYPES + ",mcf.observe",
            "padded": SEVEN_JOB_TYPES.replace(",", ", "),
            "trailing comma": SEVEN_JOB_TYPES + ",",
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
        for job_types in (PRIOR_SIX_JOB_TYPES, EIGHT_JOB_TYPES):
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
        for job_types in (PRIOR_SIX_JOB_TYPES, EIGHT_JOB_TYPES, "entity.sync"):
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


MCF_OBSERVE_CONFIG = {
    "OPENSPELL_MCF_OBSERVE_ENABLED": "1",
    "OPENSPELL_MCF_OBSERVE_INTERVAL_MINUTES": "30",
}
MCF_GATE_REFUSAL = "OPENSPELL_MCF_OBSERVE_ENABLED must be 0 or 1"
MCF_INTERVAL_REFUSAL = ("OPENSPELL_MCF_OBSERVE_INTERVAL_MINUTES must be a whole number of minutes "
                        "from 5 to 1440")
MCF_CREDENTIALS_REFUSAL = ("OPENSPELL_MCF_OBSERVE_ENABLED=1 requires the SP-API LWA credentials: "
                           "spapi-lwa-client-id, spapi-lwa-client-secret-value")


class McfObserveTests(RuntimeCase):
    def refuse_observe(self, config: dict[str, str], expected: str,
                       credentials: dict[str, str] = ALL_CREDENTIALS) -> None:
        # The whole message is fixed text naming the key, so no value can appear in it.
        self.write({**BASE_CONFIG, **config}, credentials)
        self.assertEqual(self.refuse(runtime.run_worker, expected), expected)

    def test_observe_keys_are_allowlisted_and_never_credentials(self) -> None:
        self.assertEqual(runtime.MCF_OBSERVE_KEYS, frozenset(MCF_OBSERVE_CONFIG))
        self.assertLessEqual(runtime.MCF_OBSERVE_KEYS, runtime.WORKER_ENV_KEYS)
        self.assertFalse(runtime.MCF_OBSERVE_KEYS & (set(runtime.WORKER_CREDENTIALS.values())
                                                    | set(runtime.AMAZON_CONNECTION_CREDENTIALS.values())))
        # The observe pair is the general worker's only MCF surface; no send key is allowlisted.
        self.assertEqual({key for key in runtime.WORKER_ENV_KEYS if "MCF" in key}, set(MCF_OBSERVE_CONFIG))
        self.assertEqual(runtime.MCF_OBSERVE_MINUTES, (5, 1440))

    def test_an_unlisted_mcf_key_is_refused(self) -> None:
        self.write({**BASE_CONFIG, **MCF_OBSERVE_CONFIG, "OPENSPELL_MCF_" + "UNLISTED_FIXTURE": "1"}, ALL_CREDENTIALS)
        self.refuse(runtime.run_worker, "unsupported keys")

    def test_worker_passes_valid_observe_settings_exactly(self) -> None:
        cases = (
            (MCF_OBSERVE_CONFIG, ALL_CREDENTIALS),
            ({"OPENSPELL_MCF_OBSERVE_ENABLED": "1"}, ALL_CREDENTIALS),
            ({"OPENSPELL_MCF_OBSERVE_ENABLED": "1", "OPENSPELL_MCF_OBSERVE_INTERVAL_MINUTES": "5"}, ALL_CREDENTIALS),
            ({"OPENSPELL_MCF_OBSERVE_ENABLED": "1", "OPENSPELL_MCF_OBSERVE_INTERVAL_MINUTES": "1440"}, ALL_CREDENTIALS),
            # Off needs no SP-API credential, and an interval may wait for the flag.
            ({"OPENSPELL_MCF_OBSERVE_ENABLED": "0"}, {"database-url": DATABASE}),
            ({"OPENSPELL_MCF_OBSERVE_INTERVAL_MINUTES": "60"}, {"database-url": DATABASE}),
        )
        launched_count = 0
        for config, credentials in cases:
            with self.subTest(config=config):
                for leftover in self.credentials.iterdir():
                    leftover.unlink()
                self.write({**BASE_CONFIG, **config}, credentials)
                launched, lines = self.launch(runtime.run_worker)
                for key, value in config.items():
                    self.assertEqual(launched.env[key], value)
                self.assertEqual(set(launched.env) & runtime.MCF_OBSERVE_KEYS, set(config))
                self.assertEqual(set(launched.env), {
                    "PATH", "HOME", "NODE_ENV", "DATABASE_URL", "OPENSPELL_WORKER_REVISION",
                    *BASE_CONFIG, *config,
                    *({"SP_API_LWA_CLIENT_ID", "SP_API_LWA_CLIENT_SECRET"} if credentials is ALL_CREDENTIALS else set()),
                })
                self.assertEqual(lines[0]["mode"], "worker")
                launched_count += 1
        self.assertEqual(launched_count, len(cases))

    def test_absent_flag_leaves_observation_off(self) -> None:
        self.write(BASE_CONFIG, {"database-url": DATABASE})
        launched, _ = self.launch(runtime.run_worker)
        self.assertFalse(set(launched.env) & runtime.MCF_OBSERVE_KEYS)

    def test_flag_value_is_exact(self) -> None:
        values = ("", " ", "true", "yes", "on", "2", "01", " 1", "1 ", "1\n", "\u0661")
        refused = 0
        for value in values:
            with self.subTest(value=value):
                self.refuse_observe({**MCF_OBSERVE_CONFIG, "OPENSPELL_MCF_OBSERVE_ENABLED": value}, MCF_GATE_REFUSAL)
                refused += 1
        self.assertEqual(refused, len(values))

    def test_interval_is_whole_minutes_from_5_to_1440(self) -> None:
        values = ("", " ", "0", "4", "1441", "10000", "-5", "+5", "030", "05", "30.0", "1e1", "0x10",
                  " 30", "30 ", "30\n", "thirty", "\u0663\u0660", "30,0")
        refused = 0
        for value in values:
            with self.subTest(value=value):
                self.refuse_observe({**MCF_OBSERVE_CONFIG, "OPENSPELL_MCF_OBSERVE_INTERVAL_MINUTES": value},
                                    MCF_INTERVAL_REFUSAL)
                refused += 1
        self.assertEqual(refused, len(values))

    def test_interval_is_checked_with_the_flag_off(self) -> None:
        self.refuse_observe({"OPENSPELL_MCF_OBSERVE_ENABLED": "0", "OPENSPELL_MCF_OBSERVE_INTERVAL_MINUTES": "4"},
                            MCF_INTERVAL_REFUSAL, {"database-url": DATABASE})

    def test_enabled_flag_requires_both_spapi_credentials(self) -> None:
        self.refuse_observe(MCF_OBSERVE_CONFIG, MCF_CREDENTIALS_REFUSAL, {"database-url": DATABASE})
        refused = 1
        for present in ("spapi-lwa-client-id", "spapi-lwa-client-secret-value"):
            with self.subTest(present=present):
                for leftover in self.credentials.iterdir():
                    leftover.unlink()
                self.write({**BASE_CONFIG, **MCF_OBSERVE_CONFIG},
                           {"database-url": DATABASE, present: ALL_CREDENTIALS[present]})
                self.refuse(runtime.run_worker, "must be supplied together")
                refused += 1
        self.assertEqual(refused, 3)

    def test_connection_modes_never_pass_observe_settings(self) -> None:
        self.write({**BASE_CONFIG, **SPAPI_CONFIG, **AMAZON_CONFIG, **MCF_OBSERVE_CONFIG,
                    "OPENSPELL_SPAPI_CONNECTIONS_ENABLED": "0"}, {**ALL_CREDENTIALS, **ADS_CREDENTIALS})
        started = 0
        for run in (runtime.run_spapi_connections, runtime.run_amazon_connections):
            with self.subTest(mode=run.__name__):
                launched, _ = self.launch(run)
                self.assertFalse(set(launched.env) & runtime.MCF_OBSERVE_KEYS)
                started += 1
        self.assertEqual(started, 2)



# WP-338f: WP-338n's alert webhook (a credential) and samples link (a setting).
WEBHOOK = "https://hooks.example.test/services/" + "SYNTHETIC/FIXTURE/0005"
APP_URL = "https://app.example.test"
WEBHOOK_REFUSAL = ("systemd runtime credential is invalid: mcf-alert-webhook "
                   "must be an https URL without credentials or fragment")
APP_URL_REFUSAL = "WIZARD_ADS_APP_URL must be an https origin without a path, query, fragment or credentials"
RECIPIENT_REFUSAL = ("a recipient key credential (mcf-recipient-*) is loaded into a unit other than "
                     "wizard-ads-mcf.service; remove its LoadCredentialEncrypted line")


class McfHousekeepingSettingsTests(RuntimeCase):
    def test_optional_webhook_credential_is_exact_and_never_public(self) -> None:
        self.assertEqual(runtime.WORKER_OPTIONAL_CREDENTIALS, {"mcf-alert-webhook": "OPENSPELL_MCF_ALERT_WEBHOOK_URL"})
        self.assertNotIn("OPENSPELL_MCF_ALERT_WEBHOOK_URL", runtime.WORKER_ENV_KEYS)
        self.assertFalse(set(runtime.WORKER_OPTIONAL_CREDENTIALS) & set(runtime.WORKER_CREDENTIALS))
        self.assertIn("WIZARD_ADS_APP_URL", runtime.WORKER_ENV_KEYS)

    def test_worker_maps_the_webhook_and_passes_the_app_url(self) -> None:
        self.write({**BASE_CONFIG, "WIZARD_ADS_APP_URL": APP_URL}, {"database-url": DATABASE, "mcf-alert-webhook": WEBHOOK})
        launched, lines = self.launch(runtime.run_worker)
        self.assertEqual(launched.env["OPENSPELL_MCF_ALERT_WEBHOOK_URL"], WEBHOOK)
        self.assertEqual(launched.env["WIZARD_ADS_APP_URL"], APP_URL)
        self.assertEqual(set(launched.env), {
            "PATH", "HOME", "NODE_ENV", "DATABASE_URL", "OPENSPELL_WORKER_REVISION",
            "OPENSPELL_MCF_ALERT_WEBHOOK_URL", "WIZARD_ADS_APP_URL", *BASE_CONFIG,
        })
        self.assertNotIn(WEBHOOK, json.dumps(lines))

    def test_absent_webhook_and_app_url_pass_nothing(self) -> None:
        self.write(BASE_CONFIG, {"database-url": DATABASE})
        launched, _ = self.launch(runtime.run_worker)
        self.assertFalse({"OPENSPELL_MCF_ALERT_WEBHOOK_URL", "WIZARD_ADS_APP_URL"} & set(launched.env))

    def test_valid_webhook_and_app_url_shapes_are_accepted(self) -> None:
        webhooks = (WEBHOOK, "https://hooks.example.test", "https://hooks.example.test:8443/a?b=c")
        app_urls = (APP_URL, APP_URL + "/", "https://app.example.test:8443")
        accepted = 0
        for webhook, app_url in zip(webhooks, app_urls):
            with self.subTest(webhook=webhook, app_url=app_url):
                self.write({**BASE_CONFIG, "WIZARD_ADS_APP_URL": app_url},
                           {"database-url": DATABASE, "mcf-alert-webhook": webhook})
                launched, _ = self.launch(runtime.run_worker)
                self.assertEqual(launched.env["OPENSPELL_MCF_ALERT_WEBHOOK_URL"], webhook)
                self.assertEqual(launched.env["WIZARD_ADS_APP_URL"], app_url)
                accepted += 1
        self.assertEqual(accepted, 3)

    def test_malformed_webhook_is_refused_without_its_value(self) -> None:
        values = ("http://hooks.example.test/x", "hooks.example.test/x", "https://", "https:///x",
                  "https://user:pass@hooks.example.test/x", "https://user@hooks.example.test/x",
                  "https://hooks.example.test/x#frag", "https://hooks.example.test/x#",
                  "https://hooks.example.test/two words", "https://HOOKS.example.test/x",
                  "https://hooks.example.test:99999/x", "https://[::1]/x", "https://hooks_example.test/x",
                  "ftp://hooks.example.test/x", "https://hooks.example.test/\u00e9")
        refused = 0
        for value in values:
            with self.subTest(value=value):
                self.write(BASE_CONFIG, {"database-url": DATABASE, "mcf-alert-webhook": value})
                message = self.refuse(runtime.run_worker, WEBHOOK_REFUSAL)
                self.assertEqual(message, WEBHOOK_REFUSAL)
                refused += 1
        self.assertEqual(refused, len(values))
        self.write(BASE_CONFIG, {"database-url": DATABASE, "mcf-alert-webhook": ""})
        self.refuse(runtime.run_worker, "credential is empty: mcf-alert-webhook")

    def test_malformed_app_url_is_refused_by_name(self) -> None:
        values = ("", " ", "http://app.example.test", "http://localhost:3000", "app.example.test",
                  APP_URL + "/creators", APP_URL + "?x=1", APP_URL + "?", APP_URL + "#x", APP_URL + "#",
                  "https://user@app.example.test", "https://APP.example.test", "https://app.example.test:0x1",
                  " " + APP_URL, APP_URL + " ", APP_URL + "\n")
        refused = 0
        for value in values:
            with self.subTest(value=value):
                self.write({**BASE_CONFIG, "WIZARD_ADS_APP_URL": value}, {"database-url": DATABASE})
                self.assertEqual(self.refuse(runtime.run_worker, APP_URL_REFUSAL), APP_URL_REFUSAL)
                refused += 1
        self.assertEqual(refused, len(values))

    def test_webhook_is_never_a_worker_json_key(self) -> None:
        self.write({**BASE_CONFIG, "OPENSPELL_MCF_ALERT_WEBHOOK_URL": WEBHOOK}, {"database-url": DATABASE})
        message = self.refuse(runtime.run_worker,
                              "OPENSPELL_MCF_ALERT_WEBHOOK_URL is the systemd credential mcf-alert-webhook")
        self.assertNotIn(WEBHOOK, message)

    def test_connection_modes_never_pass_the_webhook_or_app_url(self) -> None:
        self.write({**BASE_CONFIG, **SPAPI_CONFIG, **AMAZON_CONFIG, "WIZARD_ADS_APP_URL": APP_URL,
                    "OPENSPELL_SPAPI_CONNECTIONS_ENABLED": "0"},
                   {**ALL_CREDENTIALS, **ADS_CREDENTIALS, "mcf-alert-webhook": WEBHOOK})
        started = 0
        for run in (runtime.run_spapi_connections, runtime.run_amazon_connections):
            with self.subTest(mode=run.__name__):
                launched, _ = self.launch(run)
                self.assertFalse({"OPENSPELL_MCF_ALERT_WEBHOOK_URL", "WIZARD_ADS_APP_URL"} & set(launched.env))
                self.assertNotIn(WEBHOOK, json.dumps(launched.env))
                started += 1
        self.assertEqual(started, 2)

    def test_a_recipient_key_in_any_other_unit_is_refused(self) -> None:
        cases = (
            (runtime.run_worker, {**BASE_CONFIG}, {"database-url": DATABASE}),
            (runtime.run_spapi_connections, {**BASE_CONFIG, **SPAPI_CONFIG, "OPENSPELL_SPAPI_CONNECTIONS_ENABLED": "0"},
             ALL_CREDENTIALS),
            (runtime.run_amazon_connections, {**BASE_CONFIG, **AMAZON_CONFIG}, ADS_CREDENTIALS),
        )
        refused = 0
        for run, config, credentials in cases:
            for name in ("mcf-recipient-" + "0badc0de", "mcf-recipient-other",
                         "wizard-ads-mcf-recipient-" + "0badc0de.cred"):
                with self.subTest(mode=run.__name__, name=name):
                    for leftover in self.credentials.iterdir():
                        leftover.unlink()
                    self.write(config, {**credentials, name: "synthetic-recipient-" + "key-canary"})
                    message = self.refuse(run, RECIPIENT_REFUSAL)
                    self.assertEqual(message, RECIPIENT_REFUSAL)
                    self.assertNotIn("key-canary", message)
                    refused += 1
        self.assertEqual(refused, 9)


if __name__ == "__main__":
    unittest.main(verbosity=2)
