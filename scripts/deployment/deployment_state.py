"""Durable local journal shared by the explicit integrated deployment executor."""
import json
import fcntl
import tempfile
import os
from pathlib import Path


class DeploymentLease:
    """Adapter must implement atomic generation-conditional object operations.

    Production binding: existing private GCS object, ifGenerationMatch=0 on
    create and the exact returned generation on replace/delete. Never steal an
    expired lease: first reconcile outstanding cloud operations and ownership.
    """

    def __init__(self, store, key, owner):
        self.store, self.key, self.owner = store, key, owner
        self.generation = None

    def acquire(self):
        self.generation = self.store.create_if_absent(self.key, {"owner": self.owner})

    def assert_owned(self):
        value, generation = self.store.read(self.key)
        if generation != self.generation or value.get("owner") != self.owner:
            raise RuntimeError("Deployment lease changed; do not mutate or roll back")

    def renew(self):
        self.assert_owned()
        self.generation = self.store.replace_if_generation(self.key, {"owner": self.owner}, self.generation)

    def release(self):
        self.assert_owned()
        self.store.delete_if_generation(self.key, self.generation)


class DeploymentJournal:
    EFFECTS = {
        "stage_maintenance": ("service",), "stage_normal": ("service", "database"),
        "recover_normal": ("traffic",),
        "stage_recovery": ("service",), "maintenance_traffic": ("traffic",),
        "backup": ("backup",), "stage_candidate": ("service", "database"),
        "promote_candidate": ("traffic",), "recover_traffic": ("traffic",),
        "remove_tags": ("traffic",),
    }

    def __init__(self, path, source):
        self._lock(path)
        self.state = {"source": source, "phase": "prepared", "operations": [],
                      "effects": {k: "unchanged" for k in ("service", "traffic", "database", "backup")},
                      "observed": {"traffic": None, "migrations": None}}
        try:
            self._write(exclusive=True)
        except BaseException:
            self.close()
            raise

    def _lock(self, path):
        self.path = Path(path)
        self._failed = False
        self._lock_fd = os.open(str(self.path) + ".lock",
                                os.O_CREAT | os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(self._lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self._sync_directory()
        except BaseException:
            os.close(self._lock_fd)
            self._lock_fd = None
            raise RuntimeError("Run state is locked or unavailable; do not mutate")

    @classmethod
    def resume(cls, path, source):
        """Reopen without resetting effects. Pending operations still block start."""
        self = cls.__new__(cls)
        self._lock(path)
        try:
            fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, "r", encoding="utf-8") as handle:
                self.state = json.load(handle)
            state = self.state
            if (state.get("source") != source or not isinstance(state.get("phase"), str)
                    or set(state.get("effects", {})) != {"service", "traffic", "database", "backup"}
                    or not isinstance(state.get("observed"), dict)
                    or not isinstance(state.get("operations"), list)):
                raise RuntimeError("Unknown run state; manual reconciliation is required")
            for index, op in enumerate(state["operations"]):
                if (set(op) != {"name", "status"} or op["name"] not in self.EFFECTS
                        or op["status"] not in ("started", "confirmed")
                        or (op["status"] == "started" and index != len(state["operations"]) - 1)):
                    raise RuntimeError("Invalid operation state; manual reconciliation is required")
            return self
        except BaseException:
            self.close()
            raise

    def _sync_directory(self):
        fd = os.open(self.path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def _write(self, *, exclusive=False):
        if self._lock_fd is None or self._failed:
            raise RuntimeError("Closed or uncertain journal; reopen and reconcile")
        descriptor, temporary_name = tempfile.mkstemp(
            dir=self.path.parent, prefix=self.path.name + ".", suffix=".tmp")
        temporary = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(self.state, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            if exclusive:
                # link is atomic and fails if the final name already exists.
                # No exists-then-create window and no partially written final file.
                os.link(temporary, self.path, follow_symlinks=False)
            else:
                os.replace(temporary, self.path)
            self._sync_directory()
        except BaseException:
            self._failed = True
            raise
        finally:
            if temporary.exists():
                temporary.unlink()
                self._sync_directory()

    def save(self):
        self._write()

    def close(self):
        if self._lock_fd is not None:
            fcntl.flock(self._lock_fd, fcntl.LOCK_UN)
            os.close(self._lock_fd)
            self._lock_fd = None
        # Never unlink the lock file: another process may already hold its inode.

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def start(self, operation):
        if operation not in self.EFFECTS or any(x["status"] == "started" for x in self.state["operations"]):
            raise RuntimeError("Reconcile pending operation before another mutation")
        self.state["operations"].append({"name": operation, "status": "started"})
        for effect in self.EFFECTS[operation]:
            self.state["effects"][effect] = "unknown"
        self.state["phase"] = operation
        self.save()  # Write before the external request: a lost response is unknown.

    def confirm(self, operation, *, traffic=None, migrations=None):
        if not self.state["operations"]:
            raise RuntimeError("No operation to confirm")
        pending = self.state["operations"][-1]
        if pending != {"name": operation, "status": "started"}:
            raise RuntimeError("Unexpected operation confirmation")
        pending["status"] = "confirmed"
        for effect in self.EFFECTS[operation]:
            if effect != "database":
                self.state["effects"][effect] = "changed"
        if traffic is not None:
            self.state["observed"]["traffic"] = traffic
        if migrations is not None:
            self.state["observed"]["migrations"] = migrations
            self.state["effects"]["database"] = "observed_migrations"
        self.save()

    def stop(self):
        effects = self.state["effects"]
        if "unknown" in effects.values():
            outcome = "STOPPED_OUTCOME_UNKNOWN"
        elif any(effects[k] != "unchanged" for k in ("service", "traffic", "database")):
            outcome = "STOPPED_WITH_CHANGES"
        else:
            outcome = "STOPPED_NO_SERVICE_DB_TRAFFIC_CHANGE"
        self.state["phase"] = outcome
        self.save()
        return self.state
