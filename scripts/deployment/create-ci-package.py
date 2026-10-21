#!/usr/bin/env python3
"""Build a LOCAL CI fixture package. The synthetic builder digest is never run."""
import importlib.util
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("prepare", ROOT / "scripts/prepare-integrated-deployment.py")
prepare = importlib.util.module_from_spec(spec); spec.loader.exec_module(prepare)
source = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
plan = prepare.prepare(ROOT, source, "bf456bceae36186f1a0fb7e408776361506c7689", "16b437f9458791029c00252a1aef6ba872240c97",
                       Path(sys.argv[1]), "example.invalid/synthetic/ci-only", reported_pr_head="6c83c9b4566a22a099f05345f499d1de05d940c6",
                       baseline_origin="local-commit-verified", rollback_ref="86c028cd00efa1e012ef91cbb254796f952209bc",
                       docker_builder_image="example.invalid/synthetic/not-executable@sha256:" + "0" * 64)
prepare.verify_artifacts(Path(sys.argv[1]), plan["artifact_manifest_sha256"])
print("CI fixture prepared; no cloud build or deployment requested.")
