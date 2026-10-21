#!/usr/bin/env python3
"""Explicit, one-step deployment executor. Default command is read-only inspect.

Never run `step` without a separately reviewed production plan and approval hash.
This module does not create credentials, change IAM, restore a live DB, or build
images. Lost responses are reconciled by reading the known resource/operation;
an unresolved request is never resent automatically.
"""
import argparse
import copy
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

sys.dont_write_bytecode = True
from cloud_api import CloudResources, GcsStore, GoogleApi
from deployment_state import DeploymentJournal


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def revision_id(value):
    return value.rsplit("/", 1)[-1]


def traffic(revision):
    return [{"type": "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION", "revision": revision, "percent": 100}]


def effective_traffic(service):
    rows = service.get("trafficStatuses", [])
    if any(row.get("tag") or row.get("uri") for row in rows):
        raise RuntimeError("Tagged revision access must be reviewed and removed before this deployment")
    serving = [row for row in rows if row.get("percent", 0)]
    if len(serving) != 1 or serving[0].get("percent") != 100 or not serving[0].get("revision"):
        raise RuntimeError("A single explicit serving revision is required")
    return revision_id(serving[0]["revision"])


def service_observation(service):
    return {"uid": service.get("uid"), "etag": service.get("etag"),
            "generation": service.get("generation"), "observed_generation": service.get("observedGeneration"),
            "reconciling": bool(service.get("reconciling")),
            "ready": service.get("terminalCondition", {}).get("state") == "CONDITION_SUCCEEDED",
            "serving_revision": effective_traffic(service),
            "latest_revision": revision_id(service.get("latestCreatedRevision", "")),
            "policy_sha256": digest({key: service.get(key) for key in ("ingress", "invokerIamDisabled", "defaultUriDisabled", "iapEnabled", "binaryAuthorization", "scaling", "customAudiences")}),
            "template_sha256": digest(service.get("template", {})),
            "image": service.get("template", {}).get("containers", [{}])[0].get("image")}


def validate_plan(plan):
    for field in ("source_commit", "rollback_commit"):
        if not re.fullmatch(r"[0-9a-f]{40}", plan.get(field, "")):
            raise RuntimeError("Exact reviewed candidate and normal rollback commits are required")
    for name in ("candidate", "normal", "maintenance"):
        image = plan["images"][name]
        if not re.fullmatch(r"[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}", image["digest"]):
            raise RuntimeError("Deploy images by digest, never moving tags")
        if image["source_commit"] != (plan["rollback_commit"] if name == "normal" else plan["source_commit"]):
            raise RuntimeError("Image provenance does not match reviewed code")
    manifest = plan["migration_manifest"]
    if [row["version"] for row in manifest] != [f"{n:04d}" for n in range(1, 16)]:
        raise RuntimeError("Reviewed migrations 0001 through 0015 are required")
    proof = plan["normal_rollback_drill"]
    if (proof.get("source_commit") != plan["rollback_commit"] or proof.get("migration_sha256") != digest(manifest)
            or proof.get("image_digest") != plan["images"]["normal"]["digest"]
            or not all(proof.get(key) is True for key in ("login", "private_record_read", "write_and_read", "backup_restore"))):
        raise RuntimeError("Normal rollback and isolated backup/restore evidence is incomplete")
    if not re.fullmatch(r"[0-9a-f]{64}", plan.get("artifact_manifest_sha256", "")):
        raise RuntimeError("Prepared artifact inventory must be bound into approval")
    if not plan.get("image_build_review", {}).get("source_archive_verified") or not plan["image_build_review"].get("build_id"):
        raise RuntimeError("Review build provenance and the uploaded source archive before approving")


def verify_execution_package(plan, directory):
    """Require the approved exported code and complete inventory before writes."""
    directory = Path(directory).resolve()
    manifest = directory / "artifact-manifest.json"
    if hashlib.sha256(manifest.read_bytes()).hexdigest() != plan["artifact_manifest_sha256"]:
        raise RuntimeError("Prepared artifact inventory does not match the approved plan")
    files = json.loads(manifest.read_text())["files"]
    actual_paths = set()
    for path in directory.rglob("*"):
        if path.is_symlink():
            raise RuntimeError("Symlink in execution package")
        if path.is_file() and path != manifest:
            actual_paths.add(path.relative_to(directory).as_posix())
    if actual_paths != {row["path"] for row in files} or len(actual_paths) != len(files):
        raise RuntimeError("Unexpected or missing execution package file")
    for row in files:
        path = directory / row["path"]
        if not path.resolve().is_relative_to(directory) or path.stat().st_size != row["bytes"] or path.stat().st_mode & 0o777 != row["mode"] or hashlib.sha256(path.read_bytes()).hexdigest() != row["sha256"]:
            raise RuntimeError("Execution package file changed")
    if Path(__file__).resolve() != directory / "tools/scripts/deployment/integrated_executor.py":
        raise RuntimeError("Run the executor from the reviewed exported package")
    review = json.loads((directory / "review-plan.json").read_text())
    if (review.get("source_commit") != plan["source_commit"] or review["normal_rollback"].get("source_commit") != plan["rollback_commit"]
            or review["migration_manifest"] != plan["migration_manifest"]):
        raise RuntimeError("Execution plan does not match the prepared code and migrations")


class DatabaseInspector:
    """Uses an existing libpq PG* environment/service; never accepts a URL in argv."""
    def __init__(self, expected_database):
        self.expected_database = expected_database

    def read(self):
        sql = """BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SELECT json_build_object('database',current_database(),
 'migrations',(SELECT json_agg(t ORDER BY version) FROM (SELECT version,name,checksum FROM schema_migrations) t),
 'active_other_transactions',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND xact_start IS NOT NULL));
COMMIT;"""
        result = subprocess.run(["psql", "-X", "-qAt", "--no-password", "-v", "ON_ERROR_STOP=1", "-c", sql],
                                capture_output=True, text=True, timeout=10)
        if result.returncode:
            raise RuntimeError("Read-only database inspection failed; connection details suppressed")
        rows = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
        if len(rows) != 1 or rows[0].pop("database") != self.expected_database:
            raise RuntimeError("Database identity mismatch")
        return rows[0]


class DurableLease:
    """Non-expiring cooperative lease with durable checkpoints and CAS fencing.

    No automatic takeover exists, even after a process dies. Separate processes
    using the same run ID must still win the generation CAS before any mutation.
    """
    def __init__(self, store, key, owner, plan_hash):
        self.store, self.key, self.owner, self.plan_hash = store, key, owner, plan_hash
        self.generation = None

    def value(self, state):
        return {"owner": self.owner, "plan_sha256": self.plan_hash, "checkpoint": state}

    def acquire(self, state):
        self.store.check_private()
        self.generation = self.store.create_if_absent(self.key, self.value(state))

    def attach(self, state):
        value, generation = self.store.read(self.key)
        if value != self.value(state):
            raise RuntimeError("Local and global checkpoints differ; inspect both, do not replay or overwrite")
        self.generation = generation

    def assert_owned(self):
        value, generation = self.store.read(self.key)
        if generation != self.generation or value.get("owner") != self.owner or value.get("plan_sha256") != self.plan_hash:
            raise RuntimeError("Global lease changed; no further mutation or rollback is allowed")

    def checkpoint(self, state):
        self.assert_owned()
        self.generation = self.store.replace_if_generation(self.key, self.value(state), self.generation)

    def release(self):
        self.assert_owned()
        self.store.delete_if_generation(self.key, self.generation)


class IntegratedExecutor:
    STAGES = {"stage_maintenance": "maintenance", "stage_normal": "normal", "stage_candidate": "candidate"}
    PROMOTIONS = {"maintenance_traffic": "maintenance", "promote_candidate": "candidate", "recover_normal": "normal"}

    def __init__(self, plan, cloud, database, store, journal, *, clock=time.time):
        validate_plan(plan)
        self.plan, self.cloud, self.database, self.journal, self.clock = plan, cloud, database, journal, clock
        self.plan_hash = digest(plan)
        execution = journal.state.get("execution")
        if execution is None:
            execution = {"plan_sha256": self.plan_hash, "owner": uuid.uuid4().hex, "etag": plan["expected_service"]["etag"],
                         "completed": [], "revisions": {}, "pending": None}
            journal.state["execution"] = execution
            journal.save()
        if execution["plan_sha256"] != self.plan_hash:
            raise RuntimeError("Plan changed; preserve the existing run and review a new plan")
        self.state = execution
        key = "integrated-deployment/" + digest(cloud.service_name) + ".json"
        self.lease = DurableLease(store, key, execution["owner"], self.plan_hash)

    def save(self):
        self.journal.save()
        self.lease.checkpoint(self.journal.state)

    def connect_lease(self, *, new=False):
        if new:
            self.lease.acquire(self.journal.state)
        else:
            self.lease.attach(self.journal.state)

    def inspect(self):
        service = service_observation(self.cloud.get_service())
        database = self.database.read()
        self.compatible(database["migrations"])
        instance = self.cloud.instance()
        backups = self.cloud.backups()
        return {"service": service, "database": database,
                "cloud_sql": {"state": instance.get("state"), "databaseVersion": instance.get("databaseVersion"),
                              "backup_enabled": instance.get("settings", {}).get("backupConfiguration", {}).get("enabled")},
                "successful_backup_ids": [str(row["id"]) for row in backups if row.get("status") == "SUCCESSFUL"],
                "google_server_connection": "NOT_VERIFIED", "writes_performed": False}

    def compatible(self, rows, *, full=False):
        expected = self.plan["migration_manifest"]
        if not isinstance(rows, list) or len(rows) not in ([15] if full else [12, 13, 14, 15]) or rows != expected[:len(rows)]:
            raise RuntimeError("Unrecognized migration state; do not restore traffic or apply more changes")

    def checked_service(self, *, ready=True):
        self.lease.assert_owned()
        raw = self.cloud.get_service()
        observation = service_observation(raw)
        if observation["uid"] != self.plan["expected_service"]["uid"] or observation["etag"] != self.state["etag"]:
            raise RuntimeError("Cloud Run changed outside this run; stop without overwriting it")
        if observation["policy_sha256"] != self.plan["expected_service"]["policy_sha256"]:
            raise RuntimeError("Cloud Run access or scaling policy changed")
        if ready and (observation["reconciling"] or not observation["ready"]):
            raise RuntimeError("Cloud Run reconciliation is not complete")
        return raw, observation

    def step(self, action, *, approval_hash, backup_restore_evidence=None):
        if approval_hash != self.plan_hash:
            raise RuntimeError("Exact plan approval hash is required")
        if self.state["pending"]:
            raise RuntimeError("Reconcile the pending request before another mutation")
        if action in self.state["completed"]:
            raise RuntimeError("This step is already confirmed; it will not be repeated")
        if self.state.get("failed_actions") and action != "recover_normal":
            raise RuntimeError("Only normal recovery is allowed after an observed failed candidate")
        if action not in (*self.STAGES, *self.PROMOTIONS, "backup"):
            raise RuntimeError("Unknown deployment action")
        raw, observation = self.checked_service(ready=action != "recover_normal")
        db = self.database.read()
        self.compatible(db["migrations"])
        completed, revisions = self.state["completed"], self.state["revisions"]
        if not completed:
            baseline = self.plan["expected_service"]
            if action != "stage_maintenance" or observation["template_sha256"] != baseline["template_sha256"] or observation["serving_revision"] != baseline["serving_revision"]:
                raise RuntimeError("Production baseline changed or first step is invalid")
            self.state["before_migrations"] = db["migrations"]
        if action == "maintenance_traffic" and "stage_maintenance" not in completed:
            raise RuntimeError("Maintenance revision is not ready")
        if action in ("backup", "stage_normal", "stage_candidate"):
            if "maintenance_traffic" not in completed or observation["serving_revision"] != revisions["maintenance"]:
                raise RuntimeError("Maintenance must receive all traffic before a migration-capable stage")
            delay = self.plan["expected_service"]["request_timeout_seconds"] + 30
            if not 0 < delay <= 3630 or self.clock() < self.state["maintenance_since"] + delay:
                raise RuntimeError("Wait for the reviewed request drain interval; inspect again later")
            if db["active_other_transactions"] or not self.plan.get("external_writers_quiesced"):
                raise RuntimeError("Other writers are not confirmed quiescent")
        if action == "stage_normal":
            if "backup" not in completed:
                raise RuntimeError("A fresh successful backup is required")
            self.verify_restore_evidence(backup_restore_evidence)
        if action in ("stage_candidate", "promote_candidate", "recover_normal"):
            if "stage_normal" not in completed:
                raise RuntimeError("Normal recovery application has not been staged successfully")
            self.compatible(db["migrations"], full=True)
        if action == "promote_candidate" and "stage_candidate" not in completed:
            raise RuntimeError("Candidate revision is not ready")
        if action in self.PROMOTIONS:
            kind = self.PROMOTIONS[action]
            self.verify_revision(kind, revisions[kind])
            desired = {"traffic_revision": revisions[kind]}
        elif action in self.STAGES:
            kind = self.STAGES[action]
            revision = self.cloud.service[:30] + "-" + kind[:4] + "-" + self.state["owner"][:10]
            desired = {"revision": revision, "kind": kind, "image": self.plan["images"][kind]["digest"],
                       "traffic_revision": observation["serving_revision"]}
        else:
            desired = {"description": "integrated-deployment-" + self.state["owner"]}
        template = None
        if action in self.STAGES:
            template = copy.deepcopy(raw["template"])
            if len(template.get("containers", [])) != 1:
                raise RuntimeError("Multi-container service requires a separate reviewed plan")
            if template["containers"][0].get("command") or template["containers"][0].get("args"):
                raise RuntimeError("Custom container command requires separate image compatibility review")
            template["revision"] = desired["revision"]
            template["containers"][0]["image"] = desired["image"]
            template["containers"][0]["startupProbe"] = {"httpGet": {"path": "/api/health", "port": 8080}, "periodSeconds": 5, "timeoutSeconds": 5, "failureThreshold": 24}
            desired["template_sha256"] = digest(template)
        elif action != "backup":
            desired["template_sha256"] = observation["template_sha256"]
        self.state["pending"] = {"action": action, "desired": desired, "operation": None}
        self.journal.start(action)
        self.lease.checkpoint(self.journal.state)  # durable intent BEFORE the external mutation
        if action == "backup":
            result = self.cloud.create_backup(desired["description"])
        elif action in self.PROMOTIONS:
            result = self.cloud.patch_service(observation["etag"], traffic=traffic(desired["traffic_revision"]))
        else:
            result = self.cloud.patch_service(observation["etag"], traffic=traffic(desired["traffic_revision"]), template=template)
        self.state["pending"]["operation"] = result.get("name")
        self.save()
        return {"status": "REQUESTED_NOT_CONFIRMED", "action": action}

    def verify_restore_evidence(self, proof):
        # Cloud SQL operation metadata does not prove application-level contents.
        # Bind an explicit operator-reviewed clone check to this exact backup.
        if not proof or proof.get("kind") != "operator-reviewed-cloudsql-restore" or str(proof.get("backup_id")) != self.state.get("backup_id"):
            raise RuntimeError("Exact backup restore evidence is required; synthetic CI is not production restore proof")
        if proof.get("source_instance") != self.cloud.sql_instance or not isinstance(proof.get("target_instance"), str) or not proof["target_instance"] or proof["target_instance"] == self.cloud.sql_instance:
            raise RuntimeError("Restore verification must use a separate approved instance")
        operation = self.cloud.sql_operation(proof["operation_id"])
        if (operation.get("status") != "DONE" or operation.get("error") or operation.get("operationType") != "RESTORE_VOLUME"
                or operation.get("targetId") != proof.get("target_instance")
                or proof.get("migration_sha256") != digest(self.state["before_migrations"])
                or proof.get("application_read_check") is not True):
            raise RuntimeError("Restore operation or application verification is incomplete")

    def verify_revision(self, kind, revision):
        value = self.cloud.revision(revision)
        if (value.get("reconciling") or not any(c.get("type") == "Ready" and c.get("state") == "CONDITION_SUCCEEDED" for c in value.get("conditions", []))
                or value.get("containers", [{}])[0].get("image") != self.plan["images"][kind]["digest"]):
            raise RuntimeError("Reviewed revision/image is not confirmed ready")

    def reconcile(self):
        self.lease.assert_owned()
        pending = self.state["pending"]
        if not pending:
            return {"status": "NO_PENDING_REQUEST"}
        action, desired = pending["action"], pending["desired"]
        failed = False
        if pending["operation"]:
            op = self.cloud.sql_operation(pending["operation"]) if action == "backup" else self.cloud.run_operation(pending["operation"])
            done = op.get("status") == "DONE" if action == "backup" else op.get("done") is True
            if not done:
                return {"status": "PENDING", "action": action}
            if op.get("error"):
                failed = True
        raw = self.cloud.get_service()
        observation = service_observation(raw)
        if observation["uid"] != self.plan["expected_service"]["uid"] or observation["reconciling"]:
            return {"status": "OUTCOME_UNRESOLVED", "retry_allowed": False}
        if observation["policy_sha256"] != self.plan["expected_service"]["policy_sha256"]:
            return {"status": "POLICY_UNRESOLVED", "retry_allowed": False}
        db = self.database.read()
        self.compatible(db["migrations"])
        if failed:
            # A failed candidate can leave the service's terminal condition
            # failed while the separately staged normal revision is still ready.
            # Clear only this observed operation, never rerun a failed mutation.
            if action != "stage_candidate" or "stage_normal" not in self.state["completed"]:
                return {"status": "FAILED_REQUIRES_MANUAL_RECOVERY", "action": action, "retry_allowed": False}
            self.compatible(db["migrations"], full=True)
            self.verify_revision("normal", self.state["revisions"]["normal"])
            if observation["serving_revision"] != self.state["revisions"]["maintenance"] or observation["template_sha256"] != desired["template_sha256"]:
                return {"status": "FAILED_STATE_MISMATCH", "retry_allowed": False}
            self.state.setdefault("failed_actions", []).append(action)
            self.state["pending"] = None
            self.state["etag"] = observation["etag"]
            self.journal.confirm(action, traffic={observation["serving_revision"]: 100}, migrations=db["migrations"])
            self.lease.checkpoint(self.journal.state)
            return {"status": "FAILED_OBSERVED_NORMAL_RECOVERY_AVAILABLE", "retry_allowed": False}
        if not observation["ready"] and action != "recover_normal":
            return {"status": "SERVICE_NOT_READY", "retry_allowed": False}
        if action == "backup":
            if observation["etag"] != self.state["etag"]:
                return {"status": "SERVICE_CHANGED_DURING_BACKUP", "retry_allowed": False}
            matches = [b for b in self.cloud.backups() if b.get("description") == desired["description"]]
            if len(matches) != 1 or matches[0].get("status") != "SUCCESSFUL" or matches[0].get("instance") != self.cloud.sql_instance:
                return {"status": "BACKUP_UNRESOLVED", "retry_allowed": False}
            backup = matches[0]
            started = dt.datetime.fromisoformat(backup["startTime"].replace("Z", "+00:00")).timestamp()
            if started < self.state["maintenance_since"] or db["migrations"] != self.state["before_migrations"]:
                raise RuntimeError("Backup timing or pre-migration baseline mismatch")
            self.state["backup_id"] = str(backup["id"])
        else:
            if observation["template_sha256"] != desired["template_sha256"]:
                return {"status": "TEMPLATE_UNRESOLVED", "retry_allowed": False}
            if observation["serving_revision"] != desired["traffic_revision"]:
                return {"status": "TRAFFIC_UNRESOLVED", "retry_allowed": False}
            if action in self.STAGES:
                if observation["latest_revision"] != desired["revision"]:
                    return {"status": "REVISION_UNRESOLVED", "retry_allowed": False}
                self.verify_revision(desired["kind"], desired["revision"])
                self.state["revisions"][desired["kind"]] = desired["revision"]
            if action in ("stage_maintenance", "maintenance_traffic") and db["migrations"] != self.state["before_migrations"]:
                raise RuntimeError("Database changed before the approved migration phase")
            if action in ("stage_normal", "stage_candidate", "promote_candidate", "recover_normal"):
                self.compatible(db["migrations"], full=True)
        if action == "maintenance_traffic":
            self.state["maintenance_since"] = self.clock()
        self.state["etag"] = observation["etag"]
        self.state["completed"].append(action)
        self.state["pending"] = None
        self.journal.confirm(action, traffic={observation["serving_revision"]: 100}, migrations=db["migrations"])
        self.lease.checkpoint(self.journal.state)
        return {"status": "CONFIRMED", "action": action}

    def finish(self):
        if self.state["pending"] or self.state["completed"][-1:] not in (["promote_candidate"], ["recover_normal"]):
            raise RuntimeError("Keep the global lease until service restoration is confirmed")
        _raw, observation = self.checked_service(ready=self.state["completed"][-1] != "recover_normal")
        kind = "candidate" if self.state["completed"][-1] == "promote_candidate" else "normal"
        if observation["serving_revision"] != self.state["revisions"][kind]:
            raise RuntimeError("Serving revision changed")
        self.verify_revision(kind, self.state["revisions"][kind])
        self.compatible(self.database.read()["migrations"], full=True)
        self.journal.state["phase"] = "COMPLETE_" + kind.upper()
        self.save()
        self.lease.release()
        return {"status": self.journal.state["phase"], "normal_service": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--state", required=True, type=Path)
    parser.add_argument("--package", type=Path)
    parser.add_argument("--command", choices=["inspect", "step", "reconcile", "finish"], default="inspect")
    parser.add_argument("--action")
    parser.add_argument("--approval-sha256")
    parser.add_argument("--restore-evidence", type=Path)
    parser.add_argument("--new-run", action="store_true")
    args = parser.parse_args()
    plan = json.loads(args.plan.read_text())
    writes = args.command in ("step", "reconcile", "finish")
    if writes:
        validate_plan(plan)
        if not args.package:
            parser.error("The verified exported --package is required for mutating commands")
        verify_execution_package(plan, args.package)
    if writes and args.approval_sha256 != digest(plan):
        parser.error("Mutating commands require the separately approved exact plan hash")
    api = GoogleApi(allow_writes=writes)
    cloud = CloudResources(api, plan["project"], plan["region"], plan["service"], plan["sql_instance"])
    database = DatabaseInspector(plan["database_name"])
    # inspect never acquires a cloud lease and never creates/overwrites run state.
    if args.command == "inspect":
        service = service_observation(cloud.get_service())
        result = {"service": service, "database": database.read(), "backup_count": len(cloud.backups()),
                  "google_server_connection": "NOT_VERIFIED", "plan_sha256": digest(plan), "writes_performed": False}
    else:
        journal = DeploymentJournal(args.state, plan["source_commit"]) if args.new_run else DeploymentJournal.resume(args.state, plan["source_commit"])
        with journal:
            executor = IntegratedExecutor(plan, cloud, database, GcsStore(api, plan["lease_bucket"]), journal)
            executor.connect_lease(new=args.new_run)
            if args.command == "step":
                proof = json.loads(args.restore_evidence.read_text()) if args.restore_evidence else None
                result = executor.step(args.action, approval_hash=args.approval_sha256, backup_restore_evidence=proof)
            else:
                result = getattr(executor, args.command)()
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
