// GitHub CI only: real PostgreSQL + pg_dump/pg_restore + production application
// images. All accounts, passwords, journals and writes are synthetic. Runtime
// containers share a Docker INTERNAL network; no Google or AI transport exists.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { hash } from 'bcryptjs';
import { SCHEMA_SQL } from '../../src/lib/db/schema.ts';
import { DATABASE_MIGRATIONS, runDatabaseMigrations } from '../../src/lib/db/migrations.ts';

const command = promisify(execFile);
const postgresImage = 'postgres:16@sha256:ca0bd484cb98bf4b24eb1010e73fb3fcbd6714d240fbc1a10eea5b7dbecb641d';
const prefix = 'science-drill-' + randomUUID().slice(0, 8);
const network = prefix + '-net', databaseContainer = prefix + '-db';
const containers = [];
const temporary = await mkdtemp(join(tmpdir(), 'science-release-drill-'));
const password = 'synthetic-ci-only';
let database, app;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function docker(...args) {
  try {
    return (await command('docker', args, { env: { PATH: process.env.PATH }, maxBuffer: 32 * 1024 * 1024, timeout: 180000 })).stdout;
  } catch { throw new Error('Isolated Docker command failed: ' + args[0]); }
}
async function port(name, inner) {
  return JSON.parse(await docker('inspect', name))[0].NetworkSettings.Ports[inner + '/tcp'][0].HostPort;
}
async function ready(url) {
  for (let i = 0; i < 60; i++) {
    try { const response = await fetch(url + '/api/health', { signal: AbortSignal.timeout(2000) }); if (response.ok) return response.json(); } catch {}
    await pause(1000);
  }
  throw new Error('Synthetic application did not become ready');
}
async function stopApp() {
  if (app) { await docker('rm', '-f', app.name); app = null; }
}
async function startApp(image, databaseName) {
  await stopApp();
  const name = prefix + '-app-' + containers.length; containers.push(name);
  await docker('run', '-d', '--name', name, '--network', network, '-p', '127.0.0.1::8080',
    '-e', 'HOSTNAME=0.0.0.0', '-e', 'PORT=8080', '-e', 'NODE_ENV=production',
    '-e', 'DATABASE_URL=postgresql://postgres:' + password + '@' + databaseContainer + ':5432/' + databaseName,
    '-e', 'SESSION_SECRET=synthetic-isolated-session-only', image);
  app = { name, url: 'http://127.0.0.1:' + await port(name, 8080) };
  return ready(app.url);
}
async function login(loginId) {
  const response = await fetch(app.url + '/api/auth/login', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId, password }) });
  assert.equal(response.status, 200, 'synthetic login failed');
  return response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
}
async function api(cookie, id, suffix = '', data) {
  const response = await fetch(app.url + '/api/records' + suffix, { method: data ? 'POST' : 'GET',
    headers: { cookie, 'x-records-user': id, ...(data ? { 'content-type': 'application/json' } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}) });
  return { status: response.status, body: await response.json() };
}
async function allowSyntheticTeacher(pool) {
  await pool.query("INSERT INTO class_journal_teacher_assignments(class_id,teacher_id) VALUES('drill-class','drill-teacher') ON CONFLICT DO NOTHING");
  await pool.query("INSERT INTO record_teacher_classes(class_id,teacher_id) VALUES('drill-class','drill-teacher') ON CONFLICT DO NOTHING");
}
async function applicationChecks() {
  const teacher = await login('synthetic-teacher'), student = await login('10901'), peer = await login('10902');
  const teacherView = await api(teacher, 'drill-teacher', '?studentId=drill-owner');
  assert.equal(teacherView.status, 200);
  assert.match(JSON.stringify(teacherView.body.evidence), /SYNTHETIC_OWNER_JOURNAL/);
  assert.doesNotMatch(JSON.stringify(teacherView.body.evidence), /SYNTHETIC_PEER_JOURNAL/);
  assert.equal((await api(peer, 'drill-peer', '?studentId=drill-owner')).status, 403);
  const initial = await api(student, 'drill-owner'); assert.equal(initial.status, 200);
  const saved = await api(student, 'drill-owner', '', { action: 'submission', data: {
    expectedRevision: initial.body.submission.revision, selected: ['egg', 'spectrum'],
    comments: { egg: 'SYNTHETIC_ROLLBACK_WRITE' }, submit: false,
  } });
  assert.equal(saved.status, 200);
  const result = await api(student, 'drill-owner');
  assert.equal(result.status, 200); assert.match(JSON.stringify(result.body.submission), /SYNTHETIC_ROLLBACK_WRITE/);
  return { login: true, private_record_read: true, write_and_read: true };
}

try {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'This drill is restricted to an ephemeral GitHub Actions runner');
  assert.equal((await docker('context', 'show')).trim(), 'default');
  await docker('pull', postgresImage);
  await docker('network', 'create', '--internal', network);
  assert.equal(JSON.parse(await docker('network', 'inspect', network))[0].Internal, true);
  containers.push(databaseContainer);
  await docker('run', '-d', '--name', databaseContainer, '--network', network, '-p', '127.0.0.1::5432',
    '-e', 'POSTGRES_PASSWORD=' + password, '-e', 'POSTGRES_DB=science_release_drill', postgresImage);
  for (let i = 0; i < 30; i++) {
    try { await docker('exec', databaseContainer, 'pg_isready', '-U', 'postgres'); break; } catch { await pause(1000); }
  }
  const dbPort = Number(await port(databaseContainer, 5432));
  database = new Pool({ host: '127.0.0.1', port: dbPort, user: 'postgres', password, database: 'science_release_drill', max: 3 });
  assert.equal((await database.query("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public'")).rows[0].n, 0);
  await database.query(SCHEMA_SQL);
  await runDatabaseMigrations(database, DATABASE_MIGRATIONS.filter(row => row.version <= '0012'));
  const passwordHash = await hash(password, 10);
  await database.query("INSERT INTO classes(id,academic_year,class_number,name) VALUES('drill-class',2026,1,'synthetic-class')");
  await database.query("INSERT INTO users(id,login_id,name,academic_year,role,password_hash,must_change_password) VALUES('drill-teacher','synthetic-teacher','Synthetic teacher',2026,'teacher',$1,FALSE)", [passwordHash]);
  for (const [id, loginId] of [['drill-owner', '10901'], ['drill-peer', '10902']]) {
    await database.query("INSERT INTO users(id,login_id,name,academic_year,role,class_id,password_hash,must_change_password) VALUES($1,$2,'Synthetic learner',2026,'student','drill-class',$3,FALSE)", [id, loginId, passwordHash]);
  }
  await database.query("INSERT INTO teams(id,class_id,team_number,name,leader_user_id) VALUES('drill-team','drill-class',1,'Synthetic team','drill-owner')");
  for (const id of ['drill-owner', 'drill-peer']) await database.query("INSERT INTO team_members(id,team_id,user_id,joined_at) VALUES($1,'drill-team',$2,'2026-09-01')", ['member-' + id, id]);
  await database.query("INSERT INTO inquiry_sessions(id,team_id,stage) VALUES('drill-session','drill-team','EXPERIMENTING')");
  await database.query("INSERT INTO inquiry_cycles(id,session_id,ordinal,title,status,origin) VALUES('drill-cycle','drill-session',1,'Synthetic cycle','active','configured')");
  for (const [id, text] of [['drill-owner', 'SYNTHETIC_OWNER_JOURNAL'], ['drill-peer', 'SYNTHETIC_PEER_JOURNAL']]) {
    await database.query("INSERT INTO experiment_journals(id,session_id,cycle_id,student_id,session_number,journal_date,activities,observations,reflections) VALUES($1,'drill-session','drill-cycle',$2,1,'2026-10-01',$3,'synthetic','synthetic')", ['journal-' + id, id, text]);
  }
  const original = (await database.query('SELECT id,student_id,activities,observations,reflections FROM experiment_journals ORDER BY id')).rows;
  const baselineMigrations = (await database.query('SELECT version,name,checksum FROM schema_migrations ORDER BY version')).rows;
  assert.equal(baselineMigrations.length, 12);
  const maintenance = await startApp('science-inquiry-maintenance', 'science_release_drill');
  assert.equal(maintenance.mode, 'maintenance');
  assert.equal((await fetch(app.url + '/login')).status, 503);
  assert.deepEqual((await database.query('SELECT version,name,checksum FROM schema_migrations ORDER BY version')).rows, baselineMigrations);
  await stopApp();

  const dump = join(temporary, 'synthetic.dump');
  await docker('exec', databaseContainer, 'pg_dump', '-U', 'postgres', '-d', 'science_release_drill', '-Fc', '-f', '/tmp/synthetic.dump');
  await docker('cp', databaseContainer + ':/tmp/synthetic.dump', dump);
  await docker('exec', databaseContainer, 'createdb', '-U', 'postgres', 'science_release_restore');
  await docker('exec', databaseContainer, 'pg_restore', '-U', 'postgres', '-d', 'science_release_restore', '--exit-on-error', '--no-owner', '/tmp/synthetic.dump');
  const restored = new Pool({ host: '127.0.0.1', port: dbPort, user: 'postgres', password, database: 'science_release_restore', max: 2 });
  try {
    assert.deepEqual((await restored.query('SELECT version,name,checksum FROM schema_migrations ORDER BY version')).rows, baselineMigrations);
    assert.deepEqual((await restored.query('SELECT id,student_id,activities,observations,reflections FROM experiment_journals ORDER BY id')).rows, original);
    await startApp('science-inquiry-validation', 'science_release_drill');
    assert.equal((await database.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n, 15);
    assert.deepEqual((await database.query('SELECT id,student_id,activities,observations,reflections FROM experiment_journals ORDER BY id')).rows, original);
    await allowSyntheticTeacher(database);
    await startApp('science-inquiry-normal-rollback', 'science_release_drill');
    const normal = await applicationChecks();
    await startApp('science-inquiry-validation', 'science_release_drill');
    await applicationChecks();
    await startApp('science-inquiry-normal-rollback', 'science_release_restore');
    await allowSyntheticTeacher(restored);
    await applicationChecks();
    const result = { normalRollbackCommit: '86c028cd00efa1e012ef91cbb254796f952209bc',
      normalImageConfigId: JSON.parse(await docker('image', 'inspect', 'science-inquiry-normal-rollback'))[0].Id,
      candidateImageConfigId: JSON.parse(await docker('image', 'inspect', 'science-inquiry-validation'))[0].Id,
      normalService: normal, backupRestore: 'passed', restoredApplication: 'passed', migrations: 15,
      externalNetwork: 'blocked by internal Docker network', data: 'synthetic', productionCloudSqlRestore: 'not tested' };
    if (process.env.RUNNER_TEMP) await writeFile(join(process.env.RUNNER_TEMP, 'rollback-drill-result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(result));
  } finally { await restored.end(); }
} finally {
  await database?.end();
  for (const name of [...containers].reverse()) { try { await docker('rm', '-f', name); } catch {} }
  try { await docker('network', 'rm', network); } catch {}
  await rm(temporary, { recursive: true, force: true });
}
