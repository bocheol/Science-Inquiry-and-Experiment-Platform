#!/usr/bin/env python3
"""Approved journal deployment. Run in the owner's Google Cloud Shell."""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
import time
from datetime import datetime, timezone

PROJECT = "chemistry-tutor-493405"
PROJECT_NUMBER = "974188506094"
REGION = "asia-northeast3"
SERVICE = "science-inquiry-platform"
SQL_INSTANCE = "science-platform-db"
BASE = "bf456bceae36186f1a0fb7e408776361506c7689"
SOURCE = "0f52ad4d37af1fe710a9cf65e076f69763eba771"
EXPECTED_REVISION = "science-inquiry-platform-00045-hic"
EXPECTED_DIGEST = "sha256:b1e79f81d29b9b751cde2eefcc398ab7d09951d42b094b83b858d01e34f6ef42"
REPO = Path(__file__).resolve().parents[1]
RUN = datetime.now(timezone.utc).strftime("%m%d%H%M%S")
STATE_PATH = Path.home() / ("science-journal-deploy-" + RUN + ".json")
STATE = {"project": PROJECT, "service": SERVICE, "source_commit": SOURCE, "phase": "preflight"}
G = ["gcloud", "--project=" + PROJECT, "--quiet"]
bridge_ready = False
cutover_started = False

def save():
    STATE_PATH.write_text(json.dumps(STATE, ensure_ascii=False, indent=2) + "\n")
    STATE_PATH.chmod(0o600)

def note(s):
    print(s, flush=True)

def command(args, cwd=None):
    p = subprocess.run(args, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode:
        # These commands contain no credential values or student records.
        raise RuntimeError("명령 실패: " + " ".join(args[:5]) + "\n" + p.stderr[-3500:])
    return p.stdout.strip()

def gc(args):
    return json.loads(command(G + args + ["--format=json"]))

def service():
    return gc(["run", "services", "describe", SERVICE, "--region=" + REGION])

def traffic_revision(s):
    rows = [x for x in s["status"].get("traffic", []) if int(x.get("percent", 0)) > 0]
    if len(rows) != 1 or int(rows[0]["percent"]) != 100:
        raise RuntimeError("트래픽 분할 상태입니다. 자동 배포를 중단합니다.")
    return rows[0]["revisionName"]

def require_current(revision, latest=None):
    s = service()
    if traffic_revision(s) != revision:
        raise RuntimeError("다른 배포가 트래픽을 변경했습니다. 자동 전환을 중단합니다.")
    if latest and s["status"].get("latestCreatedRevisionName") != latest:
        raise RuntimeError("다른 리비전이 생성됐습니다. 자동 배포를 중단합니다.")
    return s

def spec_hash(s):
    spec = json.loads(json.dumps(s["spec"]["template"]["spec"]))
    for c in spec.get("containers", []):
        c.pop("image", None)
    a = s["spec"]["template"].get("metadata", {}).get("annotations", {})
    keys = ["run.googleapis.com/cloudsql-instances", "run.googleapis.com/vpc-access-connector",
            "run.googleapis.com/vpc-access-egress", "run.googleapis.com/network-interfaces",
            "run.googleapis.com/execution-environment", "run.googleapis.com/cpu-throttling",
            "run.googleapis.com/startup-cpu-boost", "run.googleapis.com/sessionAffinity",
            "autoscaling.knative.dev/minScale", "autoscaling.knative.dev/maxScale"]
    payload = [spec, {k: a[k] for k in keys if k in a}]
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()

def check_spec(s):
    if spec_hash(s) != STATE["runtime_spec_hash"]:
        raise RuntimeError("이미지 외 런타임 설정 변경을 감지했습니다. 자동 전환을 중단합니다.")

def revision(name):
    return gc(["run", "revisions", "describe", name, "--region=" + REGION])

def check_image(name, digest):
    r = revision(name)
    actual = r.get("status", {}).get("imageDigest", "").split("@")[-1]
    if actual != digest:
        raise RuntimeError("배포 이미지 digest가 빌드 결과와 다릅니다.")
    if not any(c.get("type") == "Ready" and c.get("status") == "True"
               for c in r.get("status", {}).get("conditions", [])):
        raise RuntimeError("리비전이 Ready 상태가 아닙니다.")

def tag_url(s, tag):
    matches = [x.get("url") for x in s["status"].get("traffic", []) if x.get("tag") == tag]
    if len(matches) != 1 or not matches[0] or not matches[0].startswith("https://"):
        raise RuntimeError("검증용 리비전 주소를 확인하지 못했습니다.")
    return matches[0]

def smoke(url, release=False):
    import urllib.request
    import urllib.error
    def request(path):
        try:
            with urllib.request.urlopen(url.rstrip("/") + path, timeout=90) as r:
                return r.status, r.read(4000)
        except urllib.error.HTTPError as e:
            return e.code, e.read(4000)
    status, body = request("/api/health")
    if status != 200 or json.loads(body).get("ok") is not True:
        raise RuntimeError("DB health 점검 실패: HTTP " + str(status))
    if request("/login")[0] != 200:
        raise RuntimeError("로그인 화면 점검 실패")
    if release:
        for path in ["/api/journal-recovery", "/api/teacher/journals", "/api/inquiry/journals"]:
            if request(path)[0] != 403:
                raise RuntimeError("비인증 접근 차단 점검 실패: " + path)

def remove_tag(tag):
    command(G + ["run", "services", "update-traffic", SERVICE, "--region=" + REGION,
                 "--remove-tags=" + tag])

def switch(name):
    command(G + ["run", "services", "update-traffic", SERVICE, "--region=" + REGION,
                 "--to-revisions=" + name + "=100"])

def archive(ref, target):
    target.mkdir()
    paths = [".dockerignore", "Dockerfile", "package.json", "pnpm-lock.yaml",
             "pnpm-workspace.yaml", "next.config.ts", "next-env.d.ts", "tsconfig.json", "public", "src"]
    raw = subprocess.check_output(["git", "archive", ref, "--"] + paths, cwd=REPO)
    with tarfile.open(fileobj=io.BytesIO(raw)) as tar:
        # Only git-tracked regular files from the fixed allowlist are uploaded.
        for member in tar.getmembers():
            if member.issym() or member.islnk() or member.name.startswith("/") or ".." in Path(member.name).parts:
                raise RuntimeError("빌드 소스에 예상하지 못한 경로가 있습니다.")
        tar.extractall(target, filter="data")

DB_CHECK = r'''
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
const require = createRequire("/tmp/journal-pg/package.json");
const {Pool} = require("pg");
const connectionString = "postgresql://synthetic:synthetic-only@journal-pg:5432/journal_deploy_test";
process.env.DATABASE_URL = connectionString;
const pool = new Pool({connectionString, max: 5, connectionTimeoutMillis: 3000});
try {
  let connected = false;
  for (let n=0; n<60; n++) {
    try { await pool.query("SELECT 1"); connected = true; break; }
    catch { await new Promise(r => setTimeout(r, 1000)); }
  }
  assert.ok(connected, "isolated PostgreSQL is unavailable");
  assert.match((await pool.query("SHOW server_version")).rows[0].server_version, /^16\./);
  const baseline = await import("/workspace/fallback/src/lib/db/migrations.ts");
  const current = await import("/workspace/release/src/lib/db/migrations.ts");
  const extract = (source, name) => {
    const tick = String.fromCharCode(96);
    const match = source.match(new RegExp("export const " + name + " = " + tick + "([\\s\\S]*?)" + tick + ";"));
    assert.ok(match, "bootstrap SQL missing"); return match[1];
  };
  const schema = await readFile("/workspace/fallback/src/lib/db/schema.ts", "utf8");
  const discussion = await readFile("/workspace/fallback/src/lib/discussion-schema.ts", "utf8");
  await pool.query(extract(schema, "SCHEMA_SQL").replace(String.fromCharCode(36) + "{DISCUSSION_SCHEMA_SQL}", extract(discussion, "DISCUSSION_SCHEMA_SQL")));
  await baseline.runDatabaseMigrations(pool);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0].n,12);
  for (let n=1; n<=9; n++) await pool.query("INSERT INTO classes(id,academic_year,class_number,name) VALUES($1,2026,$2,'synthetic')",["c"+n,n]);
  for (const [n,name] of [[1,"강석봉"],[2,"김보철"],[3,"김정원"],[4,"원창연"]])
    await pool.query("INSERT INTO users(id,name,login_id,academic_year,role,password_hash,must_change_password) VALUES($1,$2,$3,2026,'teacher','synthetic-not-a-login',FALSE)",["t"+n,name,"teacher"+n]);
  await pool.query("INSERT INTO users(id,name,login_id,academic_year,role,class_id,password_hash) VALUES('s','synthetic','synthetic-student',2026,'student','c3','synthetic-not-a-login')");
  await pool.query("INSERT INTO teams(id,class_id,team_number,name) VALUES('t','c3',1,'synthetic')");
  await pool.query("INSERT INTO inquiry_sessions(id,team_id) VALUES('ss','t')");
  await pool.query("INSERT INTO inquiry_cycles(id,session_id,ordinal,title,status,origin) VALUES('cy','ss',1,'synthetic','active','configured')");
  await pool.query("INSERT INTO experiment_journals(id,session_id,student_id,session_number,journal_date,activities,cycle_id) VALUES('j','ss','s',1,'2026-10-21','synthetic private journal','cy')");
  await pool.query("INSERT INTO experiment_journal_images(id,journal_id,client_id,content_type,file_name,byte_size,image_data) VALUES('p','j','p','image/png','synthetic.png',3,$1)",[Buffer.from([1,2,3])]);
  const columns = (await pool.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position")).rows;
  const names = [...new Set(columns.map(c=>c.table_name))].filter(t=>!["schema_migrations","schema_migration_lock"].includes(t));
  const quote = s => '"' + s.replaceAll('"','""') + '"';
  async function snapshot(){
    const result={};
    for (const name of names){
      const fields=columns.filter(c=>c.table_name===name).map(c=>quote(c.column_name)).join(",");
      const rows=(await pool.query("SELECT "+fields+" FROM "+quote(name))).rows;
      const stable=rows.map(r=>JSON.stringify(r)).sort().join("\n");
      result[name]=createHash("sha256").update(stable).digest("hex");
    }
    return result;
  }
  const before=await snapshot();
  const peers=[new Pool({connectionString}),new Pool({connectionString}),new Pool({connectionString})];
  try { await Promise.all(peers.map(p=>current.runDatabaseMigrations(p))); }
  finally { await Promise.all(peers.map(p=>p.end())); }
  assert.deepEqual(await snapshot(),before,"existing synthetic rows changed");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0].n,14);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM class_journal_teacher_assignments")).rows[0].n,9);
  await pool.query("INSERT INTO journal_recovery_assets VALUES('s','asset','opaque-ciphertext',17)");
  await pool.query("INSERT INTO journal_recovery_drafts(id,owner_id,session_id,cycle_id,revision,encrypted_data,asset_ids) VALUES('draft','s','ss','cy',1,'opaque-ciphertext','[\"asset\"]')");
  await baseline.assertDatabaseCompatibility(pool);
  await baseline.runDatabaseMigrations(pool);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0].n,14);
  assert.equal((await pool.query("SELECT encrypted_data FROM journal_recovery_drafts WHERE id='draft'")).rows[0].encrypted_data,"opaque-ciphertext");
  assert.deepEqual(await snapshot(),before,"fallback changed existing synthetic rows");
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO schema_migrations(version,name,checksum) VALUES('9999','synthetic-future','bad')");
    await assert.rejects(()=>baseline.assertDatabaseCompatibility(client));
    await client.query("ROLLBACK");
    await client.query("BEGIN");
    await client.query("UPDATE schema_migrations SET checksum='bad' WHERE version='0014'");
    await assert.rejects(()=>baseline.assertDatabaseCompatibility(client));
    await assert.rejects(()=>current.assertDatabaseCompatibility(client));
    await client.query("ROLLBACK");
  } finally { client.release(); }
  console.log(JSON.stringify({status:"passed",postgres:16,concurrentMigrators:3,versions:14,
    preservedTables:names.length,teacherAssignments:9,fallbackCompatible:true,unknownAndTamperedRejected:true}));
} finally { await pool.end(); }
'''

def make_build(build, image_base):
    archive(SOURCE, build / "release")
    archive(BASE, build / "fallback")
    source = (build / "release/src/lib/db/migrations.ts").read_text()
    extra = []
    tick = chr(96)
    for version in ["0013", "0014"]:
        pattern = r'\{\s*version: "' + version + r'",\s*name: "([^"]+)",\s*sql: ' + tick + r'([\s\S]*?)' + tick + r',\s*\}'
        matches = re.findall(pattern, source)
        if len(matches) != 1 or ("$" + "{") in matches[0][1] or "\\" in matches[0][1]:
            raise RuntimeError("고정 마이그레이션 원문을 안전하게 읽지 못했습니다.")
        extra.append({"version": version, "name": matches[0][0], "sql": matches[0][1]})
    path = build / "fallback/src/lib/db/migrations.ts"
    original = path.read_text()
    old = "const known = new Map(migrations.map((migration) => [migration.version, migration]));"
    if original.count(old) != 1:
        raise RuntimeError("복구용 버전의 호환성 검사 위치가 달라졌습니다.")
    # Pending versions remain 0001..0012. Only the exact new metadata is accepted.
    replacement = "const known = new Map([...migrations, ..." + json.dumps(extra,ensure_ascii=False) + "].map((migration) => [migration.version, migration]));"
    path.write_text(original.replace(old, replacement))
    if 'version: "0013"' in path.read_text():
        raise RuntimeError("복구용 버전에 신규 실행 마이그레이션이 들어갔습니다.")
    (build / "db-compat-check.mjs").write_text(DB_CHECK)
    bridge_tag = image_base + ":journal-fallback-" + RUN
    release_tag = image_base + ":journal-" + SOURCE[:12] + "-" + RUN
    config = {
        "timeout": "1800s",
        "steps": [
            {"name":"gcr.io/cloud-builders/docker","args":["run","--detach","--name","journal-pg","--network","cloudbuild","-e","POSTGRES_USER=synthetic","-e","POSTGRES_PASSWORD=synthetic-only","-e","POSTGRES_DB=journal_deploy_test","postgres:16"]},
            {"name":"node:24-bookworm","entrypoint":"bash","args":["-ceu","npm install --prefix /tmp/journal-pg --ignore-scripts --no-package-lock --no-audit --no-fund pg@8.23.0 >/dev/null && node /workspace/db-compat-check.mjs"]},
            {"name":"gcr.io/cloud-builders/docker","args":["build","--label","org.opencontainers.image.revision="+BASE,"--label","science.journal.fallback-compatible=0013-0014","-t",bridge_tag,"fallback"]},
            {"name":"gcr.io/cloud-builders/docker","args":["build","--label","org.opencontainers.image.revision="+SOURCE,"-t",release_tag,"release"]},
        ],
        "images":[bridge_tag,release_tag],
    }
    (build / "cloudbuild.json").write_text(json.dumps(config,indent=2))
    (build / ".gcloudignore").write_text(".git\nnode_modules\n.env\n.env.*\n")
    return bridge_tag, release_tag

def deploy(image, suffix, tag):
    name = SERVICE + "-" + suffix
    command(G + ["run","deploy",SERVICE,"--region="+REGION,"--image="+image,
                 "--revision-suffix="+suffix,"--no-traffic","--tag="+tag])
    s=service()
    check_spec(s)
    return name, tag_url(s,tag)

def main():
    global bridge_ready, cutover_started
    os.umask(0o077)
    save()
    command(["git","cat-file","-e",SOURCE+"^{commit}"],cwd=REPO)
    command(["git","cat-file","-e",BASE+"^{commit}"],cwd=REPO)
    remote=command(["git","ls-remote","origin","refs/heads/main"],cwd=REPO).split()[0]
    if remote != BASE:
        raise RuntimeError("원격 main이 점검 기준에서 바뀌었습니다. 다른 Work 변경을 통합한 뒤 배포해야 합니다.")
    project=gc(["projects","describe",PROJECT])
    if str(project["projectNumber"]) != PROJECT_NUMBER:
        raise RuntimeError("프로젝트 번호가 일치하지 않습니다.")
    initial=require_current(EXPECTED_REVISION,EXPECTED_REVISION)
    if initial["status"].get("latestReadyRevisionName") != EXPECTED_REVISION:
        raise RuntimeError("운영 Ready 리비전이 달라졌습니다.")
    if any(t.get("tag") for t in initial["status"].get("traffic",[])):
        raise RuntimeError("기존 태그가 있습니다. 구버전 주소의 권한 우회 가능성을 검토해야 합니다.")
    current=revision(EXPECTED_REVISION)
    actual=current.get("status",{}).get("imageDigest","")
    if actual.split("@")[-1] != EXPECTED_DIGEST:
        raise RuntimeError("현재 운영 이미지가 기록된 기준 이미지와 다릅니다.")
    STATE["runtime_spec_hash"]=spec_hash(initial)
    STATE["previous_revision"]=EXPECTED_REVISION
    STATE["url"]=initial["status"]["url"]
    existing_image=current["spec"]["containers"][0]["image"]
    image_base=existing_image.split("@")[0]
    if len(initial["spec"]["template"]["spec"].get("containers",[])) != 1:
        raise RuntimeError("다중 컨테이너 구성입니다. 자동 배포를 중단합니다.")
    if ":" in image_base.rsplit("/",1)[-1]:
        image_base=image_base.rsplit(":",1)[0]
    if not image_base.startswith(REGION+"-docker.pkg.dev/"+PROJECT+"/"):
        raise RuntimeError("기존 Artifact Registry 경로가 예상과 다릅니다.")
    sql=gc(["sql","instances","describe",SQL_INSTANCE])
    if sql.get("databaseVersion") != "POSTGRES_16":
        raise RuntimeError("예상한 PostgreSQL 16 인스턴스가 아닙니다.")
    connection=PROJECT+":"+REGION+":"+SQL_INSTANCE
    socket_env=initial["spec"]["template"]["spec"]["containers"][0].get("env",[])
    socket=[e.get("value") for e in socket_env if e.get("name")=="INSTANCE_UNIX_SOCKET"]
    if socket != ["/cloudsql/"+connection]:
        raise RuntimeError("서비스의 Cloud SQL 연결 대상이 예상과 다릅니다.")
    note("[1/6] 고정 커밋의 격리 PostgreSQL 검사 및 새 이미지/복구 이미지 빌드")
    with tempfile.TemporaryDirectory(prefix="science-journal-build-") as directory:
        build=Path(directory)
        bridge_tag,release_tag=make_build(build,image_base)
        build_id=command(G+["builds","submit",str(build),"--region=global","--config="+str(build/"cloudbuild.json"),
                            "--async","--format=value(id)"])
        if not re.fullmatch(r"[a-f0-9-]{36}",build_id):
            raise RuntimeError("빌드 ID를 확인하지 못했습니다.")
        STATE.update(build_id=build_id,phase="building")
        save()
        note("Cloud Build ID: "+build_id+" — 30초마다 상태를 표시합니다.")
        for _ in range(75):
            result=gc(["builds","describe",build_id,"--region=global"])
            status=result["status"]
            if status=="SUCCESS": break
            if status not in ["QUEUED","WORKING","PENDING"]:
                try:
                    log=command(G+["builds","log",build_id,"--region=global"])
                    note("\n".join(log.splitlines()[-60:]))
                except Exception: pass
                raise RuntimeError("빌드/격리 검사 실패: "+status+" / build "+build_id)
            note("빌드 상태: "+status)
            time.sleep(30)
        else: raise RuntimeError("빌드 대기 시간이 초과되었습니다. 운영 변경은 시작하지 않았습니다.")
        images={x["name"]:x["digest"] for x in result.get("results",{}).get("images",[])}
        bridge_digest=images[bridge_tag]
        release_digest=images[release_tag]
    STATE.update(bridge_image=image_base+"@"+bridge_digest,release_image=image_base+"@"+release_digest,phase="backup")
    save()
    require_current(EXPECTED_REVISION,EXPECTED_REVISION)
    note("[2/6] 운영 Cloud SQL 온디맨드 백업 생성 및 성공 확인")
    description="journal-predeploy-"+RUN
    command(G+["sql","backups","create","--instance="+SQL_INSTANCE,"--description="+description,"--format=none"])
    backups=gc(["sql","backups","list","--instance="+SQL_INSTANCE,"--filter=description="+description,
                "--sort-by=~endTime","--limit=1"])
    if len(backups)!=1 or backups[0].get("status")!="SUCCESSFUL":
        raise RuntimeError("성공한 새 DB 백업을 확인하지 못했습니다. 운영 배포를 시작하지 않습니다.")
    STATE["backup_id"]=str(backups[0]["id"])
    save()
    note("백업 성공: "+STATE["backup_id"])
    require_current(EXPECTED_REVISION,EXPECTED_REVISION)
    note("[3/6] 기존 기능의 DB 호환 복구용 리비전 배포/상태 확인")
    bridge_suffix="jf-"+RUN
    bridge_label="journal-fallback-"+RUN
    STATE.update(bridge_revision=SERVICE+"-"+bridge_suffix,phase="fallback-deploying")
    save()
    bridge_name,bridge_url=deploy(STATE["bridge_image"],bridge_suffix,bridge_label)
    STATE.update(bridge_revision=bridge_name,phase="fallback-verification")
    save()
    check_image(bridge_name,bridge_digest)
    smoke(bridge_url)
    remove_tag(bridge_label)
    require_current(EXPECTED_REVISION,bridge_name)
    switch(bridge_name)
    require_current(bridge_name,bridge_name)
    smoke(STATE["url"])
    bridge_ready=True
    STATE["phase"]="fallback-active"
    save()
    note("[4/6] 일지 개선 리비전 0% 배포 및 DB/비인증 접근 점검")
    release_label="journal-verify-"+RUN
    STATE.update(release_revision=SERVICE+"-jp-"+RUN,release_tag=release_label,phase="release-deploying")
    save()
    release_name,release_url=deploy(STATE["release_image"],"jp-"+RUN,release_label)
    STATE.update(release_revision=release_name,release_tag=release_label,phase="release-verification")
    save()
    check_image(release_name,release_digest)
    smoke(release_url,release=True)
    require_current(bridge_name,release_name)
    note("[5/6] 새 리비전으로 트래픽 전환 및 공개 주소 점검")
    cutover_started=True
    switch(release_name)
    latest=require_current(release_name,release_name)
    check_spec(latest)
    smoke(STATE["url"],release=True)
    remove_tag(release_label)
    final=require_current(release_name,release_name)
    if any(t.get("tag") for t in final["status"].get("traffic",[])):
        raise RuntimeError("검증용 태그 제거를 확인하지 못했습니다.")
    check_image(release_name,release_digest)
    STATE["phase"]="success"
    save()
    note("[6/6] DEPLOYMENT_SUCCESS")
    for key in ["source_commit","build_id","backup_id","release_revision","bridge_revision","url"]:
        note(key+": "+str(STATE[key]))
    note("배포 결과 파일: "+str(STATE_PATH))
    note("운영 학생 계정으로 저장/업로드 시험이나 유료 AI 호출은 실행하지 않았습니다.")

def run():
    try:
        main()
    except Exception as error:
        note("DEPLOYMENT_STOPPED: "+str(error))
        # Never restore a production DB automatically: post-backup student work must survive.
        # After cutover only, restore traffic to the schema-compatible fallback.
        if bridge_ready and cutover_started:
            try:
                s=service()
                if traffic_revision(s)==STATE.get("release_revision"):
                    switch(STATE["bridge_revision"])
                    STATE["phase"]="fallback-restored"
                    note("호환 복구용 리비전으로 트래픽을 되돌렸습니다. DB 원문은 복원/삭제하지 않았습니다.")
            except Exception:
                note("자동 트래픽 복구를 확인하지 못했습니다. 위 결과 파일과 오류를 전달해 주세요.")
        if STATE.get("release_tag"):
            try: remove_tag(STATE["release_tag"])
            except Exception: note("검증 태그 제거를 확인하지 못했습니다.")
        if STATE.get("bridge_revision"):
            try: remove_tag("journal-fallback-"+RUN)
            except Exception: pass
        save()
        note("결과 파일: "+str(STATE_PATH))
        note("여기서 멈추고 출력 결과를 전달해 주세요. 기존 00045 리비전이나 DB 백업으로 임의 복원하지 마세요.")
        sys.exit(1)

if __name__=="__main__":
    run()
