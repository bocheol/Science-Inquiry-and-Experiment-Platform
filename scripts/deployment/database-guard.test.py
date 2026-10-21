"""Offline identity/visibility rejection tests; no production credentials/network."""
import copy
import json
from pathlib import Path
from types import SimpleNamespace
import unittest

from database_guard import DatabaseInspector, assert_run_database, database_target, request_timeout


class DatabaseGuardTests(unittest.TestCase):
    def setUp(self):
        self.instance = {"project": "synthetic-project", "name": "synthetic-instance", "region": "synthetic-region",
            "connectionName": "synthetic-project:synthetic-region:synthetic-instance", "createTime": "2026-01-01T00:00:00Z",
            "instanceType": "CLOUD_SQL_INSTANCE", "state": "RUNNABLE", "databaseVersion": "POSTGRES_16",
            "settings": {"ipConfiguration": {"serverCaMode": "GOOGLE_MANAGED_INTERNAL_CA"}},
            "serverCaCert": {"cert": "-----BEGIN CERTIFICATE-----\nc3ludGhldGljLWNh\n-----END CERTIFICATE-----\n"},
            "ipAddresses": [{"type": "PRIVATE", "ipAddress": "192.0.2.10"}]}
        self.target = database_target(self.instance, "synthetic-project", "synthetic-instance", "same_name")
        self.environment = {"PGHOST": "192.0.2.10", "PGDATABASE": "same_name", "PGUSER": "synthetic-reader",
                            "PGPASSWORD": "SYNTHETIC_PRIVATE_PASSWORD", "PGSSLMODE": "disable", "PGOPTIONS": "untrusted-options"}
        self.observation = {"database": "same_name", "tls": True, "stats_visible": True, "track_activities": True,
                            "unknown_client_sessions": 0, "active_other_transactions": 0, "prepared_transactions": 0, "migrations": []}
        self.calls = []
        def runner(command, **kwargs):
            self.calls.append((command, kwargs))
            self.assertEqual(Path(kwargs["env"]["PGSSLROOTCERT"]).read_text(), self.target["certificate"])
            return SimpleNamespace(returncode=0, stdout=json.dumps(self.observation), stderr="")
        self.inspector = DatabaseInspector("same_name", environment=self.environment, runner=runner)

    def test_verified_connection_forces_instance_ca_and_readonly_options(self):
        result = self.inspector.read(self.target)
        command, kwargs = self.calls[0]
        self.assertEqual(kwargs["env"]["PGSSLMODE"], "verify-ca")
        self.assertEqual(kwargs["env"]["PGGSSENCMODE"], "disable")
        self.assertEqual(kwargs["env"]["PGOPTIONS"], "-c default_transaction_read_only=on")
        self.assertEqual(kwargs["env"]["PGHOSTADDR"], "192.0.2.10")
        self.assertFalse(Path(kwargs["env"]["PGSSLROOTCERT"]).exists())
        self.assertNotIn("SYNTHETIC_PRIVATE_PASSWORD", json.dumps(result) + str(command))
        self.assertEqual(len(result["target_sha256"]), 64)

    def test_same_database_name_different_endpoint_never_connects(self):
        self.environment["PGHOST"] = "192.0.2.99"
        with self.assertRaisesRegex(RuntimeError, "does not match"): self.inspector.read(self.target)
        self.assertEqual(self.calls, [])

    def test_opaque_proxy_multihost_and_service_routes_fail_closed(self):
        for override in [{"PGHOST": "/cloudsql/synthetic"}, {"PGHOST": "127.0.0.1"}, {"PGHOST": "192.0.2.10,192.0.2.11"},
                         {"PGSERVICE": "opaque"}, {"PGHOSTADDR": "192.0.2.99"}, {"PGPORT": "6432"}]:
            with self.subTest(override=override):
                inspector = DatabaseInspector("same_name", environment={**self.environment, **override}, runner=self.inspector.runner)
                with self.assertRaises(RuntimeError): inspector.read(self.target)
        self.assertEqual(self.calls, [])

    def test_shared_ca_or_wrong_cloud_instance_is_not_identity_evidence(self):
        for change in ["shared", "wrong-name", "missing-cert"]:
            instance = copy.deepcopy(self.instance)
            if change == "shared": instance["settings"]["ipConfiguration"]["serverCaMode"] = "GOOGLE_MANAGED_CAS_CA"
            elif change == "wrong-name": instance["name"] = "different-instance"
            else: instance.pop("serverCaCert")
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                database_target(instance, "synthetic-project", "synthetic-instance", "same_name")

    def test_missing_tls_or_changed_database_never_supplies_evidence(self):
        for change in [{"tls": False}, {"database": "different_name"}]:
            original = copy.deepcopy(self.observation); self.observation.update(change)
            with self.subTest(change=change), self.assertRaises(RuntimeError): self.inspector.read(self.target)
            self.observation = original

    def test_hidden_other_role_statistics_cannot_turn_zero_into_quiescence(self):
        self.observation["stats_visible"] = False
        with self.assertRaisesRegex(RuntimeError, "visibility"): self.inspector.read(self.target)

    def test_disabled_or_unknown_session_tracking_fails_closed(self):
        for change in [{"track_activities": False}, {"unknown_client_sessions": 1}, {"active_other_transactions": None}]:
            original = copy.deepcopy(self.observation); self.observation.update(change)
            with self.subTest(change=change), self.assertRaises(RuntimeError): self.inspector.read(self.target)
            self.observation = original

    def test_driver_errors_and_malformed_output_do_not_expose_details(self):
        for result in [SimpleNamespace(returncode=1, stdout="SYNTHETIC_PRIVATE", stderr="SYNTHETIC_PRIVATE"),
                       SimpleNamespace(returncode=0, stdout="{SYNTHETIC_PRIVATE", stderr="")]:
            self.inspector.runner = lambda *_args, **_kwargs: result
            with self.assertRaises(RuntimeError) as caught: self.inspector.read(self.target)
            self.assertNotIn("SYNTHETIC_PRIVATE", str(caught.exception))

    def test_plain_database_name_cannot_contain_libpq_options(self):
        with self.assertRaises(RuntimeError): database_target(self.instance, "synthetic-project", "synthetic-instance", "dbname=same_name host=elsewhere")

    def test_run_mount_and_literal_database_must_match_cloud_sql(self):
        connection = self.instance["connectionName"]
        spec = {"containers": [{"env": [{"name": "DB_NAME", "value": "same_name"},
                                         {"name": "INSTANCE_UNIX_SOCKET", "value": "/cloudsql/" + connection}],
                                "volumeMounts": [{"name": "db", "mountPath": "/cloudsql"}]}],
                "volumes": [{"name": "db", "cloudSqlInstance": {"instances": [connection]}}]}
        assert_run_database(spec, self.target)
        for change in ["mount", "opaque", "dsn"]:
            value = copy.deepcopy(spec)
            if change == "mount": value["volumes"][0]["cloudSqlInstance"]["instances"] = ["different-instance"]
            elif change == "opaque": value["containers"][0]["env"][0] = {"name": "DB_NAME", "valueSource": {"secretKeyRef": {"secret": "synthetic"}}}
            else: value["containers"][0]["env"].append({"name": "DATABASE_URL", "value": "SYNTHETIC_PRIVATE_DSN"})
            with self.subTest(change=change), self.assertRaises(RuntimeError) as caught: assert_run_database(value, self.target)
            self.assertNotIn("SYNTHETIC_PRIVATE_DSN", str(caught.exception))

    def test_actual_timeout_is_required_bounded_and_rounded_up(self):
        self.assertEqual(request_timeout({"timeout": "300.000000001s"}), 301)
        for value in [None, "", "0s", "3601s", "-1s", 1]:
            with self.subTest(value=value), self.assertRaises(RuntimeError): request_timeout({"timeout": value})


if __name__ == "__main__":
    unittest.main(verbosity=2)
