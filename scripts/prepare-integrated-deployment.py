#!/usr/bin/env python3
"""Prepare an integrated build and recovery package. NEVER contacts cloud services.

No deploy/execute option exists. A source tree can be used for local review;
release approval requires an immutable commit and fresh CI for that commit.
"""
import argparse
import ctypes
import errno
import os
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PINNED_TOOLS = [
    "scripts/prepare-integrated-deployment.py",
    "scripts/deployment/deployment_state.py",
    "scripts/deployment/cloud_api.py",
    "scripts/deployment/integrated_executor.py",
    "scripts/deployment/google-readonly.mjs",
    "scripts/deployment/rollback-drill.mjs",
    "scripts/deployment/migration-manifest.mjs",
    "scripts/deployment/recovery-policy.mjs",
    "scripts/deployment/recovery-server.mjs",
    "scripts/verify-standalone-extraction.mjs",
]
ALLOWLIST = [".dockerignore", "Dockerfile", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "next.config.ts", "next-env.d.ts", "tsconfig.json", "public", "src"]


def git(repo, *args, binary=False):
    return subprocess.check_output(["git", *args], cwd=repo, text=not binary)


def archive(repo, ref, target):
    target.mkdir()
    payload = git(repo, "archive", ref, "--", *ALLOWLIST, binary=True)
    with tarfile.open(fileobj=io.BytesIO(payload)) as archive_file:
        for member in archive_file.getmembers():
            parts = Path(member.name).parts
            if member.issym() or member.islnk() or member.name.startswith("/") or ".." in parts or not (member.isfile() or member.isdir()):
                raise RuntimeError("Unsafe archive member")
            if any(p.startswith(".env") for p in parts) or member.name.endswith((".pem", ".key")):
                raise RuntimeError("Private configuration must not enter the build")
        archive_file.extractall(target, filter="data")


def deny_network():
    """Linux child-only seccomp restriction; fail closed if unavailable."""
    lib = ctypes.CDLL("libseccomp.so.2", use_errno=True)
    lib.seccomp_init.argtypes = [ctypes.c_uint32]
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    lib.seccomp_load.argtypes = [ctypes.c_void_p]
    lib.seccomp_release.argtypes = [ctypes.c_void_p]
    ctx = lib.seccomp_init(0x7fff0000)  # SCMP_ACT_ALLOW
    if not ctx:
        raise RuntimeError("Network isolation unavailable")
    try:
        for name in ("socket", "connect", "sendto", "sendmsg", "sendmmsg"):
            number = lib.seccomp_syscall_resolve_name(name.encode())
            if number < 0 or lib.seccomp_rule_add(ctx, 0x00050000 | errno.EPERM, number, 0):
                raise RuntimeError("Network isolation unavailable")
        if lib.seccomp_load(ctx):
            raise RuntimeError("Network isolation unavailable")
    finally:
        lib.seccomp_release(ctx)


def isolated_node(arguments, read_roots, *, cwd):
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node 24 is required")
    return subprocess.check_output(
        [str(Path(node).resolve()), "--permission",
         *["--allow-fs-read=" + str(Path(root).resolve()) for root in read_roots], *map(str, arguments)],
        cwd=cwd, env={"PATH": os.defpath}, stdin=subprocess.DEVNULL,
        preexec_fn=deny_network, timeout=60, text=True)


def manifest(path, helper):
    return json.loads(isolated_node([helper, path], [path, helper.parent], cwd=path))


def pin_tools(repo, source, output):
    # Fail if the running preparer differs from the fixed object being reviewed.
    # The operational entry point must also be launched from that reviewed export.
    own_path = "scripts/prepare-integrated-deployment.py"
    own_bytes = git(repo, "show", source + ":" + own_path, binary=True)
    if Path(__file__).read_bytes() != own_bytes:
        raise RuntimeError("Preparer differs from source object; run its reviewed copy")
    origins = []
    for name in PINNED_TOOLS:
        content = git(repo, "show", source + ":" + name, binary=True)
        target = output / "tools" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        origins.append({"path": name, "object": source,
                        "blob": git(repo, "rev-parse", source + ":" + name).strip(),
                        "sha256": hashlib.sha256(content).hexdigest()})
    return origins


def artifact_inventory(output):
    entries = []
    for path in sorted(output.rglob("*")):
        if path.name == "artifact-manifest.json" and path.parent == output:
            continue
        if path.is_symlink():
            raise RuntimeError("Unexpected artifact symlink")
        if path.is_file():
            entries.append({"path": path.relative_to(output).as_posix(),
                            "bytes": path.stat().st_size, "mode": stat.S_IMODE(path.stat().st_mode),
                            "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    return entries


def verify_artifacts(output, expected_sha256):
    output = Path(output)
    inventory = output / "artifact-manifest.json"
    if hashlib.sha256(inventory.read_bytes()).hexdigest() != expected_sha256:
        raise RuntimeError("Artifact inventory digest changed")
    if json.loads(inventory.read_text()) != {"files": artifact_inventory(output)}:
        raise RuntimeError("Prepared artifact files, modes or contents changed")


def verify_manifests(baseline, reviewed, candidate):
    expected = [f"{n:04d}" for n in range(1, 16)]
    if [row["version"] for row in candidate] != expected:
        raise RuntimeError("The integrated release must contain exactly 0001 through 0015")
    if [row["version"] for row in baseline] != expected[:12] or candidate[:12] != baseline:
        raise RuntimeError("Published 0001-0012 metadata/checksums changed")
    if reviewed != candidate:
        raise RuntimeError("Reviewed PR migration metadata/checksums changed, including 0013-0015")


def pinned_image(value):
    if not re.fullmatch(r"[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}", value):
        raise RuntimeError("Container image must use an explicit reviewed sha256 digest")
    return value


def pin_rollback_dockerfile(directory, node_image):
    path = directory / "Dockerfile"
    original = path.read_bytes()
    text, count = re.subn(r"(?m)^FROM node:24-alpine(?:@sha256:[0-9a-f]{64})?(?= AS |$)",
                         "FROM " + node_image, original.decode())
    if count != 2:
        raise RuntimeError("Unrecognized rollback Dockerfile; review its build before preparing")
    path.write_text(text)
    return {"path": "Dockerfile", "original_sha256": hashlib.sha256(original).hexdigest(),
            "prepared_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "change": "Pin the two Node base image references to the reviewed digest; application source unchanged"}


def prepare(repo, source, baseline_ref, reviewed_tree, output, image_base, source_is_tree=False,
            *, reported_pr_head, rollback_ref, docker_builder_image,
            rollback_is_tree=False, baseline_origin="reconstructed-pr-diff"):
    for value in (source, baseline_ref, reviewed_tree, reported_pr_head, rollback_ref):
        if not re.fullmatch(r"[0-9a-f]{40}", value):
            raise RuntimeError("Use exact Git object IDs; moving branches are not accepted")
    if git(repo, "cat-file", "-t", source).strip() != ("tree" if source_is_tree else "commit"):
        raise RuntimeError("Source object type does not match the declared source kind")
    if git(repo, "cat-file", "-t", reviewed_tree).strip() != "tree":
        raise RuntimeError("Reviewed baseline must identify its exact local tree")
    git(repo, "cat-file", "-e", baseline_ref + "^{commit}")
    git(repo, "cat-file", "-e", reviewed_tree + "^{tree}")
    if git(repo, "cat-file", "-t", rollback_ref).strip() != ("tree" if rollback_is_tree else "commit"):
        raise RuntimeError("Rollback source object type does not match")
    pinned_image(docker_builder_image)
    if not re.fullmatch(r"[a-z0-9.-]+/[a-z0-9_./-]+", image_base) or ".." in image_base:
        raise RuntimeError("Provide the reviewed container repository, without tag or digest")
    if baseline_origin not in ("reconstructed-pr-diff", "local-commit-verified"):
        raise RuntimeError("Declare the reviewed baseline origin")
    if baseline_origin == "local-commit-verified":
        git(repo, "cat-file", "-e", reported_pr_head + "^{commit}")
        if git(repo, "rev-parse", reported_pr_head + "^{tree}").strip() != reviewed_tree:
            raise RuntimeError("PR commit does not match the reviewed tree")
    output = Path(output).resolve()
    output.mkdir(mode=0o700)  # Never overwrite a prepared run.
    tool_origins = pin_tools(repo, source, output)
    helper = output / "tools/scripts/deployment/migration-manifest.mjs"
    archive(repo, source, output / "release")
    dockerfile = (output / "release/Dockerfile").read_text()
    node_images = re.findall(r"(?m)^FROM (node:24-alpine@sha256:[0-9a-f]{64})", dockerfile)
    if len(node_images) != 2 or len(set(node_images)) != 1:
        raise RuntimeError("Both application Node bases must use the same reviewed digest")
    node_image = pinned_image(node_images[0])
    archive(repo, rollback_ref, output / "rollback")
    rollback_build_change = pin_rollback_dockerfile(output / "rollback", node_image)
    with tempfile.TemporaryDirectory(prefix="integration-baselines-") as temporary:
        temporary = Path(temporary)
        archive(repo, baseline_ref, temporary / "baseline")
        archive(repo, reviewed_tree, temporary / "reviewed")
        candidate = manifest(output / "release", helper)
        verify_manifests(manifest(temporary / "baseline", helper), manifest(temporary / "reviewed", helper), candidate)
        if manifest(output / "rollback", helper) != candidate:
            raise RuntimeError("Normal rollback application must support exactly the candidate migration checksums")
    recovery = output / "recovery"; recovery.mkdir()
    for name in ("recovery-policy.mjs", "recovery-server.mjs"):
        shutil.copyfile(output / "tools/scripts/deployment" / name, recovery / name)
    (recovery / "migrations.json").write_text(json.dumps(candidate, indent=2) + "\n")
    (recovery / "Dockerfile").write_text("FROM " + node_image + "\n" + """\
WORKDIR /app
RUN npm install -g pnpm@11.19.0
COPY release/package.json release/pnpm-lock.yaml release/pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY recovery/recovery-policy.mjs recovery/recovery-server.mjs recovery/migrations.json ./
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD [\"node\", \"recovery-server.mjs\"]
""")
    checks = output / "checks"; checks.mkdir()
    # Read the extraction checker from the selected tree, not a mutable worktree.
    shutil.copyfile(output / "tools/scripts/verify-standalone-extraction.mjs", checks / "standalone.mjs")
    (checks / "extraction.ts").write_text(git(repo, "show", source + ":src/lib/student-records/extraction.ts"))
    (checks / "recovery.mjs").write_text("""import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateMigrationRows, readCompatibility, recoveryHandler} from '/app/recovery-policy.mjs';
const expected=JSON.parse(readFileSync('/app/migrations.json','utf8'));
for(const n of [12,13,14,15]) assert.equal(validateMigrationRows(expected.slice(0,n),expected).length,n);
assert.throws(()=>validateMigrationRows([...expected,{version:'9999'}],expected));
assert.throws(()=>validateMigrationRows([...expected.slice(0,14),{...expected[14],checksum:'bad'}],expected));
const calls=[];
await readCompatibility({connect:async()=>({query:async sql=>{calls.push(sql);return {rows:expected};},release(){}})},expected);
assert.deepEqual(calls,['BEGIN READ ONLY','SELECT version, name, checksum FROM schema_migrations ORDER BY version','COMMIT']);
for(const url of ['/api/records','/api/records?history=1','/api/records/journal-images/synthetic','/api/inquiry/journals']){
  let status;
  await recoveryHandler({},expected)({method:'GET',url},{setHeader(){},writeHead(s){status=s;},end(){}});
  assert.equal(status,503);
}
console.log(JSON.stringify({recovery:'maintenance-read-only',versions:expected.length,network:'disabled',data:'synthetic'}));
""")
    label = ("review-tree-" if source_is_tree else "commit-") + source[:12]
    release_image = image_base + ":integrated-" + label + "-$BUILD_ID"
    recovery_image = image_base + ":maintenance-" + label + "-$BUILD_ID"
    rollback_image = image_base + ":rollback-" + rollback_ref[:12] + "-$BUILD_ID"
    config = {"timeout": "1800s", "steps": [
        {"name": docker_builder_image, "args": ["build", "--label", "org.opencontainers.image.revision=" + source, "-t", release_image, "release"]},
        {"name": docker_builder_image, "args": ["build", "--label", "org.opencontainers.image.revision=" + rollback_ref, "-t", rollback_image, "rollback"]},
        {"name": docker_builder_image, "args": ["build", "-f", "recovery/Dockerfile", "--label", "org.opencontainers.image.revision=" + source, "--label", "science.recovery.mode=read-only-maintenance", "-t", recovery_image, "."]},
        {"name": docker_builder_image, "args": ["run", "--rm", "--network", "none", "--mount", "type=bind,source=/workspace/checks,target=/verify,readonly", "--entrypoint", "node", release_image, "/verify/standalone.mjs", "/verify/extraction.ts"]},
        {"name": docker_builder_image, "args": ["run", "--rm", "--network", "none", "--mount", "type=bind,source=/workspace/checks,target=/verify,readonly", "--entrypoint", "node", recovery_image, "/verify/recovery.mjs"]},
    ], "images": [release_image, rollback_image, recovery_image]}
    (output / "cloudbuild.review.json").write_text(json.dumps(config, indent=2) + "\n")
    (output / ".gcloudignore").write_text(".git\nnode_modules\n.env\n.env.*\n*.state.json\n")
    plan = {"mode": "PREPARED_ONLY_NOT_DEPLOYED", "source_commit": None if source_is_tree else source,
            "source_tree": git(repo, "rev-parse", source + "^{tree}").strip(), "reviewed_tree": reviewed_tree,
            "baseline_commit": baseline_ref, "migration_manifest": candidate,
            "reported_pr_head": reported_pr_head, "reviewed_baseline_origin": baseline_origin,
            "remote_pr_commit_object_verified": baseline_origin == "local-commit-verified",
            "reconstructed_from_main_commit": baseline_ref if baseline_origin == "reconstructed-pr-diff" else None,
            "tool_sources": tool_origins,
            "image_inputs": {"node": node_image, "docker_builder": docker_builder_image},
            "normal_rollback": {"source_commit": None if rollback_is_tree else rollback_ref,
                                "source_tree": git(repo, "rev-parse", rollback_ref + "^{tree}").strip(),
                                "dockerfile_derivation": rollback_build_change,
                                "migrations_match_candidate": True,
                                "runtime_drill_required": True},
            "migration_check_isolation": {"network": "Linux seccomp denies socket/connect/send syscalls",
                                         "environment": "PATH only; no inherited credentials",
                                         "filesystem": "Node read permission limited to exported sources and pinned helper"},
            "artifact_inventory": "artifact-manifest.json",
            "artifact_hash_definition": "SHA-256 of inventory covering every other file in the preparation directory",
            "required_before_execution": ["immutable reviewed commit", "fresh full CI for exact commit including PostgreSQL and normal rollback/backup restore drill", "reviewed container builds by digest with verified source archive and provenance", "current production read-only baseline and account mapping", "existing private global lease bucket plus Cloud Run etag", "approved maintenance window, writer quiescence, fresh DB backup and separate-instance restore evidence", "exact execution plan hash and explicit integrated deployment approval"],
            "recovery": "Separate normal rollback application on the same 0015 schema; maintenance image remains 503-only. No automatic database restore or old 0012 application rollback.",
            "production_observed": False, "cloud_commands_executed": False}
    plan["manifest_sha256"] = hashlib.sha256(json.dumps(candidate, sort_keys=True).encode()).hexdigest()
    (output / "review-plan.json").write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n")
    inventory = output / "artifact-manifest.json"
    inventory.write_text(json.dumps({"files": artifact_inventory(output)}, sort_keys=True, indent=2) + "\n")
    return {**plan, "artifact_manifest_sha256": hashlib.sha256(inventory.read_bytes()).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--source-ref"); group.add_argument("--source-tree")
    parser.add_argument("--baseline-ref", required=True)
    parser.add_argument("--reviewed-tree", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--image-base", required=True)
    parser.add_argument("--reported-pr-head", required=True)
    rollback = parser.add_mutually_exclusive_group(required=True)
    rollback.add_argument("--rollback-ref"); rollback.add_argument("--rollback-tree")
    parser.add_argument("--docker-builder-image", required=True)
    parser.add_argument("--baseline-origin", choices=["reconstructed-pr-diff", "local-commit-verified"], default="reconstructed-pr-diff")
    args = parser.parse_args()
    plan = prepare(ROOT, args.source_ref or args.source_tree, args.baseline_ref, args.reviewed_tree, args.output, args.image_base, bool(args.source_tree), reported_pr_head=args.reported_pr_head, baseline_origin=args.baseline_origin, rollback_ref=args.rollback_ref or args.rollback_tree, rollback_is_tree=bool(args.rollback_tree), docker_builder_image=args.docker_builder_image)
    print(json.dumps({"output": str(args.output), "mode": plan["mode"], "migrations": len(plan["migration_manifest"]), "source_commit": plan["source_commit"], "artifact_manifest_sha256": plan["artifact_manifest_sha256"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
