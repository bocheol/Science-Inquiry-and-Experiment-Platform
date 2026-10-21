#!/usr/bin/env python3
"""Run deployment-tool checks with no inherited credentials or network access."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("prepare", ROOT / "scripts/prepare-integrated-deployment.py")
prepare = importlib.util.module_from_spec(spec); spec.loader.exec_module(prepare)
source = sys.argv[1] if len(sys.argv) > 1 else subprocess.check_output(["git", "rev-parse", "HEAD^{tree}"], cwd=ROOT, text=True).strip()
environment = {"PATH": os.environ.get("PATH", os.defpath), "PYTHONDONTWRITEBYTECODE": "1"}
for script, arguments in [
    ("deployment-state.test.py", []), ("executor.test.py", []), ("preparation.test.py", [source]),
]:
    subprocess.run([sys.executable, str(ROOT / "scripts/deployment" / script), *arguments],
                   cwd=ROOT, env=environment, preexec_fn=prepare.deny_network, check=True)
for name in ["recovery-policy.test.mjs", "google-readonly.test.mjs"]:
    print(prepare.isolated_node([ROOT / "scripts/deployment" / name], [ROOT], cwd=ROOT))
