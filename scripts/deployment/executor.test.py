"""Offline state-machine and adapter tests. All cloud responses are synthetic."""
import copy
import datetime as dt
import json
from pathlib import Path
import tempfile
import unittest
import urllib.error

from cloud_api import CloudError, GoogleApi, GcsStore
from deployment_state import DeploymentJournal
from integrated_executor import IntegratedExecutor, digest, service_observation, traffic


class Store:
    def __init__(self):
        self.values = {}; self.sequence = 0
    def check_private(self): pass
    def create_if_absent(self, key, value):
        if key in self.values: raise CloudError(412)
        return self.replace_if_generation(key, value, "0")
    def read(self, key):
        if key not in self.values: raise CloudError(404)
        value, generation = self.values[key]
        return copy.deepcopy(value), generation
    def replace_if_generation(self, key, value, generation):
        if (self.values.get(key) or (None, "0"))[1] != generation: raise CloudError(412)
        self.sequence += 1; current = str(self.sequence)
        self.values[key] = (copy.deepcopy(value), current)
        return current
    def delete_if_generation(self, key, generation):
        if self.read(key)[1] != generation: raise CloudError(412)
        del self.values[key]


class Database:
    def __init__(self, rows): self.rows = copy.deepcopy(rows); self.active = 0
    def read(self): return {"migrations": copy.deepcopy(self.rows), "active_other_transactions": self.active}


class Cloud:
    project = "synthetic-project"; region = "synthetic-region"; service = "synthetic-service"; sql_instance = "synthetic-db"
    service_name = "projects/synthetic-project/locations/synthetic-region/services/synthetic-service"
    def __init__(self, database, rows, images, clock):
        self.database, self.rows, self.images, self.clock = database, rows, images, clock
        self.raw = {"uid": "synthetic-uid", "etag": "etag-1", "generation": "1", "observedGeneration": "1", "reconciling": False,
                    "terminalCondition": {"state": "CONDITION_SUCCEEDED"}, "latestCreatedRevision": "synthetic-previous",
                    "template": {"revision": "synthetic-previous", "timeout": "1s", "containers": [{"image": "synthetic-previous-image", "env": [{"name": "SYNTHETIC", "value": "DO_NOT_LOG_SYNTHETIC_SECRET"}]}]},
                    "trafficStatuses": traffic("synthetic-previous")}
        self.calls = []; self.operations = {}; self.revisions = {}; self.backup_rows = []
        self.lose_response = False; self.fail_candidate = False; self.pending_operation = False
    def get_service(self): return copy.deepcopy(self.raw)
    def revision(self, revision): return copy.deepcopy(self.revisions[revision])
    def instance(self): return {"state": "RUNNABLE", "databaseVersion": "POSTGRES_16", "settings": {"backupConfiguration": {"enabled": True}}}
    def backups(self): return copy.deepcopy(self.backup_rows)
    def patch_service(self, etag, *, traffic, template=None):
        if etag != self.raw["etag"]: raise CloudError(409)
        self.calls.append("patch")
        self.raw["etag"] = "etag-" + str(len(self.calls) + 1)
        self.raw["trafficStatuses"] = copy.deepcopy(traffic)
        failed = False
        if template:
            self.raw["template"] = copy.deepcopy(template)
            revision = template["revision"]
            self.raw["latestCreatedRevision"] = revision
            image = template["containers"][0]["image"]
            failed = self.fail_candidate and image == self.images["candidate"]["digest"]
            self.revisions[revision] = {"conditions": [{"type": "Ready", "state": "CONDITION_FAILED" if failed else "CONDITION_SUCCEEDED"}], "containers": [{"image": image}]}
            if image == self.images["normal"]["digest"]:
                self.database.rows = copy.deepcopy(self.rows)
        self.raw["terminalCondition"]["state"] = "CONDITION_FAILED" if failed else "CONDITION_SUCCEEDED"
        name = "projects/synthetic-project/locations/synthetic-region/operations/op-" + str(len(self.calls))
        self.operations[name] = {"done": not self.pending_operation, **({"error": {"code": 13}} if failed else {})}
        if self.lose_response:
            self.lose_response = False; raise CloudError()
        return {"name": name}
    def run_operation(self, name): return copy.deepcopy(self.operations[name])
    def create_backup(self, description):
        self.calls.append("backup")
        self.backup_rows.append({"id": "123", "description": description, "instance": self.sql_instance, "status": "SUCCESSFUL", "type": "ON_DEMAND", "startTime": dt.datetime.fromtimestamp(self.clock(), dt.timezone.utc).isoformat()})
        return {"name": "synthetic-backup-operation"}
    def sql_operation(self, name):
        return {"status": "DONE", "operationType": "RESTORE_VOLUME" if name == "synthetic-restore" else "BACKUP_VOLUME", "targetId": "synthetic-restore-target"}


class ExecutorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "run.json"
        self.now = 1800000000
        self.rows = [{"version": f"{n:04d}", "name": "synthetic", "checksum": digest(n)} for n in range(1, 16)]
        images = {kind: {"digest": "example.invalid/synthetic/" + kind + "@sha256:" + str(i) * 64, "source_commit": ("a" if kind != "normal" else "b") * 40} for i, kind in enumerate(["candidate", "normal", "maintenance"], 1)}
        self.db = Database(self.rows[:12]); self.store = Store()
        self.cloud = Cloud(self.db, self.rows, images, lambda: self.now)
        observed = service_observation(self.cloud.get_service())
        self.plan = {"source_commit": "a" * 40, "rollback_commit": "b" * 40, "images": images, "migration_manifest": self.rows,
                     "artifact_manifest_sha256": "c" * 64, "external_writers_quiesced": True,
                     "expected_service": {**observed, "request_timeout_seconds": 1},
                     "image_build_review": {"source_archive_verified": True, "build_id": "synthetic-build"},
                     "normal_rollback_drill": {"source_commit": "b" * 40, "image_digest": images["normal"]["digest"], "migration_sha256": digest(self.rows),
                                               "login": True, "private_record_read": True, "write_and_read": True, "backup_restore": True}}
        self.journal = DeploymentJournal(self.path, "a" * 40); self.addCleanup(lambda: self.journal.close())
        self.executor = IntegratedExecutor(self.plan, self.cloud, self.db, self.store, self.journal, clock=lambda: self.now)
        self.executor.connect_lease(new=True)

    def step(self, name, **kwargs):
        self.executor.step(name, approval_hash=digest(self.plan), **kwargs)
        self.assertEqual(self.executor.reconcile()["status"], "CONFIRMED")

    def through_backup(self):
        self.step("stage_maintenance"); self.step("maintenance_traffic"); self.now += 60; self.step("backup")

    def proof(self):
        return {"kind": "operator-reviewed-cloudsql-restore", "backup_id": "123", "source_instance": self.cloud.sql_instance,
                "target_instance": "synthetic-restore-target", "operation_id": "synthetic-restore", "migration_sha256": digest(self.rows[:12]), "application_read_check": True}

    def test_full_sequence_binds_images_backup_and_normal_recovery_before_promotion(self):
        self.through_backup(); self.step("stage_normal", backup_restore_evidence=self.proof()); self.step("stage_candidate"); self.step("promote_candidate")
        self.assertEqual(self.executor.finish()["status"], "COMPLETE_CANDIDATE")
        self.assertEqual(self.store.values, {})
        self.assertNotIn("DO_NOT_LOG_SYNTHETIC_SECRET", self.path.read_text())
        self.assertEqual(self.cloud.calls.count("backup"), 1)

    def test_no_approval_or_stale_service_performs_no_cloud_mutation(self):
        with self.assertRaisesRegex(RuntimeError, "approval"):
            self.executor.step("stage_maintenance", approval_hash="wrong")
        self.cloud.raw["etag"] = "changed"
        with self.assertRaisesRegex(RuntimeError, "outside"):
            self.executor.step("stage_maintenance", approval_hash=digest(self.plan))
        self.assertEqual(self.cloud.calls, [])

    def test_second_run_and_stolen_generation_cannot_mutate(self):
        path = Path(self.temp.name) / "second.json"
        with DeploymentJournal(path, "a" * 40) as journal:
            other = IntegratedExecutor(self.plan, self.cloud, self.db, self.store, journal)
            with self.assertRaises(CloudError): other.connect_lease(new=True)
        key = self.executor.lease.key
        value, generation = self.store.read(key)
        self.store.replace_if_generation(key, value, generation)
        with self.assertRaisesRegex(RuntimeError, "lease changed"):
            self.executor.step("stage_maintenance", approval_hash=digest(self.plan))
        self.assertEqual(self.cloud.calls, [])

    def test_lost_response_is_reconciled_without_repeating_request_after_restart(self):
        self.cloud.lose_response = True
        with self.assertRaises(CloudError):
            self.executor.step("stage_maintenance", approval_hash=digest(self.plan))
        self.journal.close()
        self.journal = DeploymentJournal.resume(self.path, "a" * 40)
        self.executor = IntegratedExecutor(self.plan, self.cloud, self.db, self.store, self.journal, clock=lambda: self.now)
        self.executor.connect_lease()
        self.assertEqual(self.executor.reconcile()["status"], "CONFIRMED")
        self.assertEqual(self.cloud.calls, ["patch"])
        with self.assertRaisesRegex(RuntimeError, "already confirmed"):
            self.executor.step("stage_maintenance", approval_hash=digest(self.plan))

    def test_pending_operation_cannot_release_lease_or_advance(self):
        self.cloud.pending_operation = True
        self.executor.step("stage_maintenance", approval_hash=digest(self.plan))
        self.assertEqual(self.executor.reconcile()["status"], "PENDING")
        with self.assertRaises(RuntimeError): self.executor.finish()
        with self.assertRaises(RuntimeError): self.executor.step("maintenance_traffic", approval_hash=digest(self.plan))
        self.assertTrue(self.store.values)

    def test_missing_or_live_target_restore_proof_blocks_migration_capable_stage(self):
        self.through_backup(); before = list(self.cloud.calls)
        for proof in [None, {**self.proof(), "target_instance": self.cloud.sql_instance}, {**self.proof(), "backup_id": "wrong"}]:
            with self.assertRaises(RuntimeError):
                self.executor.step("stage_normal", approval_hash=digest(self.plan), backup_restore_evidence=proof)
        self.assertEqual(self.cloud.calls, before)
        self.assertEqual(len(self.db.rows), 12)

    def test_failed_candidate_can_restore_normal_service_without_db_restore(self):
        self.through_backup(); self.step("stage_normal", backup_restore_evidence=self.proof())
        self.cloud.fail_candidate = True
        self.executor.step("stage_candidate", approval_hash=digest(self.plan))
        self.assertEqual(self.executor.reconcile()["status"], "FAILED_OBSERVED_NORMAL_RECOVERY_AVAILABLE")
        with self.assertRaisesRegex(RuntimeError, "Only normal recovery"):
            self.executor.step("stage_candidate", approval_hash=digest(self.plan))
        self.step("recover_normal")
        self.assertEqual(self.executor.finish()["status"], "COMPLETE_NORMAL")
        self.assertEqual(self.db.rows, self.rows)

    def test_unknown_schema_never_promotes_or_restores_traffic(self):
        self.through_backup(); self.step("stage_normal", backup_restore_evidence=self.proof())
        self.db.rows[-1]["checksum"] = "changed"
        before = list(self.cloud.calls)
        with self.assertRaisesRegex(RuntimeError, "migration state"):
            self.executor.step("recover_normal", approval_hash=digest(self.plan))
        self.assertEqual(self.cloud.calls, before)

    def test_drain_interval_and_active_transactions_block_backup(self):
        self.step("stage_maintenance"); self.step("maintenance_traffic")
        with self.assertRaisesRegex(RuntimeError, "drain"):
            self.executor.step("backup", approval_hash=digest(self.plan))
        self.now += 60; self.db.active = 1
        with self.assertRaisesRegex(RuntimeError, "quiescent"):
            self.executor.step("backup", approval_hash=digest(self.plan))
        self.assertNotIn("backup", self.cloud.calls)

    def test_read_only_inspection_does_not_call_mutations_or_claim_google_connection(self):
        before = copy.deepcopy(self.store.values)
        result = self.executor.inspect()
        self.assertFalse(result["writes_performed"])
        self.assertEqual(result["google_server_connection"], "NOT_VERIFIED")
        self.assertEqual(self.store.values, before); self.assertEqual(self.cloud.calls, [])


class AdapterTests(unittest.TestCase):
    def test_read_only_client_rejects_write_before_fetching_a_token(self):
        api = GoogleApi(token_provider=lambda: self.fail("token must not be requested"))
        with self.assertRaisesRegex(RuntimeError, "Read-only"):
            api.request("PATCH", "run", "/synthetic", {})

    def test_http_failure_suppresses_private_response_details(self):
        def fail(*_args, **_kwargs):
            raise urllib.error.HTTPError("https://synthetic.invalid", 403, "synthetic-private-value", {}, None)
        api = GoogleApi(token_provider=lambda: "synthetic-token", transport=fail)
        with self.assertRaises(CloudError) as error: api.request("GET", "run", "/synthetic")
        self.assertEqual(error.exception.status, 403)
        self.assertNotIn("private-value", str(error.exception))

    def test_gcs_operations_use_generation_preconditions_and_consistent_reads(self):
        calls = []
        class Api:
            def request(self, method, api, path, body=None, query=None):
                calls.append((method, api, path, body, query))
                return {"owner": "synthetic"} if query and query.get("alt") == "media" else {"generation": "7"}
        store = GcsStore(Api(), "synthetic-private-bucket")
        self.assertEqual(store.create_if_absent("service/lock", {"owner": "synthetic"}), "7")
        self.assertEqual(calls[-1][-1]["ifGenerationMatch"], "0")
        store.read("service/lock")
        self.assertEqual(calls[-1][-1]["ifGenerationMatch"], "7")
        store.replace_if_generation("service/lock", {}, "7")
        self.assertEqual(calls[-1][-1]["ifGenerationMatch"], "7")
        store.delete_if_generation("service/lock", "8")
        self.assertEqual(calls[-1][-1]["ifGenerationMatch"], "8")


if __name__ == "__main__":
    unittest.main(verbosity=2)
