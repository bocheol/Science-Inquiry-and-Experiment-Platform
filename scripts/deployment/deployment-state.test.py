"""Local filesystem/process tests; no cloud executor or production data."""
import json
import multiprocessing as mp
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
from deployment_state import DeploymentJournal


def contender(path, start, release, result):
    start.wait(5)
    try:
        with DeploymentJournal(path, "synthetic-source"):
            result.put("created")
            release.wait(5)
    except (RuntimeError, FileExistsError):
        result.put("blocked")


def interrupted(path):
    journal = DeploymentJournal(path, "synthetic-source")
    journal.start("stage_candidate")
    os._exit(0)


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="deployment-journal-test-")
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "run.state.json"

    def test_exclusive_creation_and_resume_never_reset_existing_state(self):
        with DeploymentJournal(self.path, "synthetic-source") as journal:
            before = self.path.read_bytes()
            with self.assertRaises(RuntimeError):
                DeploymentJournal(self.path, "other-source")
            with self.assertRaises(RuntimeError):
                DeploymentJournal.resume(self.path, "synthetic-source")
            self.assertEqual(self.path.read_bytes(), before)
            self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        with self.assertRaises(FileExistsError):
            DeploymentJournal(self.path, "synthetic-source")
        self.assertEqual(self.path.read_bytes(), before)
        with self.assertRaises(RuntimeError):
            DeploymentJournal.resume(self.path, "other-source")

    def test_simultaneous_creators_have_one_owner(self):
        ctx = mp.get_context("fork")
        start, release, result = ctx.Event(), ctx.Event(), ctx.Queue()
        children = [ctx.Process(target=contender, args=(self.path, start, release, result)) for _ in range(2)]
        for child in children:
            child.start()
        try:
            start.set()
            self.assertEqual(sorted(result.get(timeout=5) for _ in children), ["blocked", "created"])
        finally:
            release.set()
            for child in children:
                child.join(5)
                if child.is_alive():
                    child.terminate()
                    child.join()
        self.assertEqual([child.exitcode for child in children], [0, 0])
        with DeploymentJournal.resume(self.path, "synthetic-source") as journal:
            self.assertEqual(journal.state["phase"], "prepared")

    def test_crash_and_restart_preserve_unknown_operations(self):
        child = mp.get_context("fork").Process(target=interrupted, args=(self.path,))
        child.start()
        child.join(5)
        self.assertEqual(child.exitcode, 0)
        with DeploymentJournal.resume(self.path, "synthetic-source") as journal:
            self.assertEqual(journal.state["effects"]["database"], "unknown")
            with self.assertRaises(RuntimeError):
                journal.start("promote_candidate")
            self.assertEqual(journal.stop()["phase"], "STOPPED_OUTCOME_UNKNOWN")
        with DeploymentJournal.resume(self.path, "synthetic-source") as journal:
            journal.confirm("stage_candidate", migrations=["0015"])
            self.assertEqual(journal.stop()["phase"], "STOPPED_WITH_CHANGES")

    def test_failed_replace_keeps_complete_prior_file_and_poisoned_writer(self):
        with DeploymentJournal(self.path, "synthetic-source") as journal:
            before = self.path.read_bytes()
            with patch("deployment_state.os.replace", side_effect=OSError("synthetic interruption")):
                with self.assertRaises(OSError):
                    journal.start("maintenance_traffic")
            self.assertEqual(self.path.read_bytes(), before)
            with self.assertRaises(RuntimeError):
                journal.save()
            self.assertEqual(list(self.path.parent.glob("*.tmp")), [])
        with DeploymentJournal.resume(self.path, "synthetic-source") as journal:
            self.assertEqual(journal.state["phase"], "prepared")

    def test_failure_after_replace_requires_reconciliation(self):
        with DeploymentJournal(self.path, "synthetic-source") as journal:
            with patch.object(journal, "_sync_directory", side_effect=OSError("synthetic fsync error")):
                with self.assertRaises(OSError):
                    journal.start("maintenance_traffic")
            with self.assertRaises(RuntimeError):
                journal.save()
        with DeploymentJournal.resume(self.path, "synthetic-source") as journal:
            self.assertEqual(journal.stop()["phase"], "STOPPED_OUTCOME_UNKNOWN")

    def test_unique_temporary_names_and_file_plus_directory_fsync(self):
        synced, paths = [], []
        original_sync, original_temp = os.fsync, tempfile.mkstemp

        def sync(fd):
            synced.append(stat.S_ISDIR(os.fstat(fd).st_mode))
            original_sync(fd)

        def temporary(*args, **kwargs):
            result = original_temp(*args, **kwargs)
            paths.append(result[1])
            return result

        with patch("deployment_state.os.fsync", side_effect=sync), patch("deployment_state.tempfile.mkstemp", side_effect=temporary):
            with DeploymentJournal(self.path, "synthetic-source") as journal:
                journal.start("maintenance_traffic")
                journal.confirm("maintenance_traffic", traffic={"synthetic-recovery": 100})
                self.assertEqual(journal.stop()["phase"], "STOPPED_WITH_CHANGES")
        self.assertEqual(len(paths), len(set(paths)))
        self.assertGreaterEqual(len(paths), 4)
        self.assertTrue(all(not Path(path).exists() for path in paths))
        self.assertIn(True, synced)
        self.assertIn(False, synced)

    def test_corrupt_state_is_never_overwritten_on_resume(self):
        self.path.write_text('{"source":')
        with self.assertRaises(json.JSONDecodeError):
            DeploymentJournal.resume(self.path, "synthetic-source")
        self.assertEqual(self.path.read_text(), '{"source":')


if __name__ == "__main__":
    unittest.main(verbosity=2)
