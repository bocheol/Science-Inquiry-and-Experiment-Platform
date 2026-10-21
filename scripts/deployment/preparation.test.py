"""Fixed-object preparation tests. Node imports run in the restricted sandbox."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import integrated_executor

ROOT = Path(__file__).resolve().parents[2]
SOURCE = sys.argv.pop(1)
MAIN = "bf456bceae36186f1a0fb7e408776361506c7689"
BASELINE = "16b437f9458791029c00252a1aef6ba872240c97"
REPORTED_PR = "6c83c9b4566a22a099f05345f499d1de05d940c6"
ROLLBACK_TREE = "2d5e08efca729e6e7f96d80450c034d840c3b181"
BUILDER = "example.invalid/synthetic/builder@sha256:" + "0" * 64
spec = importlib.util.spec_from_file_location("prepare_integration", ROOT / "scripts/prepare-integrated-deployment.py")
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="integration-preparation-test-")
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name) / "package"

    def run_prepare(self, **kwargs):
        return prepare.prepare(ROOT, SOURCE, MAIN, BASELINE, self.output,
                               "example.invalid/synthetic/review", True,
                               reported_pr_head=REPORTED_PR, rollback_ref=ROLLBACK_TREE,
                               rollback_is_tree=True, docker_builder_image=BUILDER, **kwargs)

    def test_pinned_helpers_ignore_mutable_worktree_and_inventory_covers_outputs(self):
        original = Path.read_bytes
        local_helpers = ROOT / "scripts/deployment"

        def guarded(path):
            if path.is_relative_to(local_helpers):
                raise AssertionError("Mutable helper read")
            return original(path)

        with patch.object(Path, "read_bytes", guarded):
            plan = self.run_prepare()
        self.assertIsNone(plan["source_commit"])
        self.assertEqual(plan["source_tree"], SOURCE)
        self.assertFalse(plan["remote_pr_commit_object_verified"])
        self.assertEqual(plan["reviewed_baseline_origin"], "reconstructed-pr-diff")
        self.assertEqual(plan["reported_pr_head"], REPORTED_PR)
        self.assertEqual(plan["reconstructed_from_main_commit"], MAIN)
        self.assertEqual(plan["normal_rollback"]["source_tree"], ROLLBACK_TREE)
        self.assertTrue(plan["normal_rollback"]["migrations_match_candidate"])
        self.assertIn("@sha256:", plan["image_inputs"]["node"])
        self.assertTrue(all(step["name"] == BUILDER for step in json.loads((self.output / "cloudbuild.review.json").read_text())["steps"]))
        self.assertEqual([row["version"] for row in plan["migration_manifest"]], [f"{n:04d}" for n in range(1, 16)])
        for item in plan["tool_sources"]:
            fixed = subprocess.check_output(["git", "show", SOURCE + ":" + item["path"]], cwd=ROOT)
            self.assertEqual(item["sha256"], hashlib.sha256(fixed).hexdigest())
            self.assertEqual((self.output / "tools" / item["path"]).read_bytes(), fixed)
        for name in ["recovery-policy.mjs", "recovery-server.mjs"]:
            fixed = subprocess.check_output(["git", "show", SOURCE + ":scripts/deployment/" + name], cwd=ROOT)
            self.assertEqual((self.output / "recovery" / name).read_bytes(), fixed)
        prepare.verify_artifacts(self.output, plan["artifact_manifest_sha256"])
        (self.output / "recovery/recovery-policy.mjs").write_text("// synthetic tamper\n")
        with self.assertRaisesRegex(RuntimeError, "files, modes or contents"):
            prepare.verify_artifacts(self.output, plan["artifact_manifest_sha256"])

    def test_preparer_must_match_selected_object(self):
        fake = Path(self.temp.name) / "modified-preparer.py"
        fake.write_text("# synthetic changed preparer")
        with patch.object(prepare, "__file__", str(fake)):
            with self.assertRaisesRegex(RuntimeError, "Preparer differs"):
                self.run_prepare()

    def test_execution_requires_the_reviewed_copy_and_untampered_complete_package(self):
        plan = self.run_prepare()
        execution_plan = {"source_commit": plan["source_commit"], "rollback_commit": plan["normal_rollback"]["source_commit"],
                          "migration_manifest": plan["migration_manifest"], "artifact_manifest_sha256": plan["artifact_manifest_sha256"]}
        with self.assertRaisesRegex(RuntimeError, "reviewed exported"):
            integrated_executor.verify_execution_package(execution_plan, self.output)
        with patch.object(integrated_executor, "__file__", str(self.output / "tools/scripts/deployment/integrated_executor.py")):
            integrated_executor.verify_execution_package(execution_plan, self.output)
            (self.output / "tools/scripts/deployment/cloud_api.py").write_text("# modified helper\n")
            with self.assertRaisesRegex(RuntimeError, "file changed"):
                integrated_executor.verify_execution_package(execution_plan, self.output)

    def test_moving_refs_and_incorrect_source_kind_are_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "exact Git object"):
            prepare.prepare(ROOT, "main", MAIN, BASELINE, self.output, "example.invalid/synthetic/review",
                            True, reported_pr_head=REPORTED_PR, rollback_ref=ROLLBACK_TREE, rollback_is_tree=True, docker_builder_image=BUILDER)
        with self.assertRaisesRegex(RuntimeError, "object type"):
            prepare.prepare(ROOT, MAIN, MAIN, BASELINE, self.output, "example.invalid/synthetic/review",
                            True, reported_pr_head=REPORTED_PR, rollback_ref=ROLLBACK_TREE, rollback_is_tree=True, docker_builder_image=BUILDER)

    def test_mutable_image_reference_is_rejected(self):
        for value in ["node:24-alpine", "gcr.io/cloud-builders/docker:latest", "example.invalid/image@sha256:bad"]:
            with self.assertRaisesRegex(RuntimeError, "digest"):
                prepare.pinned_image(value)

    def test_import_sandbox_blocks_network_credentials_and_unrelated_files(self):
        code = """const assert=require('node:assert/strict'), fs=require('node:fs'), net=require('node:net');
assert.deepEqual(Object.keys(process.env),['PATH']);
assert.throws(()=>fs.readFileSync('/etc/passwd'),{code:'ERR_ACCESS_DENIED'});
const socket=net.connect({host:'127.0.0.1',port:9});
socket.on('connect',()=>{throw Error('Network isolation failed');});
socket.on('error',error=>{assert.equal(error.code,'EPERM');console.log('isolated');});"""
        self.assertEqual(prepare.isolated_node(["-e", code], [self.temp.name], cwd=self.temp.name).strip(), "isolated")

    def test_migration_comparison_rejects_changed_baseline_or_integrated_metadata(self):
        rows = [{"version": f"{n:04d}", "name": "synthetic", "checksum": str(n)} for n in range(1, 16)]
        prepare.verify_manifests(rows[:12], rows, rows)
        bad = [dict(row) for row in rows]
        bad[0]["checksum"] = "changed"
        with self.assertRaisesRegex(RuntimeError, "0001-0012"):
            prepare.verify_manifests(rows[:12], rows, bad)
        bad = [dict(row) for row in rows]
        bad[14]["checksum"] = "changed"
        with self.assertRaisesRegex(RuntimeError, "0013-0015"):
            prepare.verify_manifests(rows[:12], rows, bad)


if __name__ == "__main__":
    unittest.main(verbosity=2)
