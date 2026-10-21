// Dependency-free authorization smoke. Executes actual TypeScript functions and
// SQL against in-memory SQLite; NOT a replacement for PostgreSQL/Vitest/Next.
// Schema validators and framework response helpers are stubs. All data synthetic.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import * as vm from 'node:vm';
import * as crypto from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(`
CREATE TABLE classes(id TEXT PRIMARY KEY, academic_year INT, class_number INT);
CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,login_id TEXT,class_id TEXT,role TEXT,status TEXT DEFAULT 'active',must_change_password INT DEFAULT 0,academic_year INT DEFAULT 2026,account_type TEXT DEFAULT 'standard',is_master INT DEFAULT 0);
CREATE TABLE record_teacher_classes(class_id TEXT PRIMARY KEY,teacher_id TEXT);
CREATE TABLE class_journal_teacher_assignments(class_id TEXT,teacher_id TEXT,PRIMARY KEY(class_id,teacher_id));
CREATE TABLE record_submissions(student_id TEXT PRIMARY KEY,revision INT DEFAULT 0,selected TEXT DEFAULT '[]',comments TEXT DEFAULT '{}',status TEXT DEFAULT 'draft',returned_note TEXT DEFAULT '',reopened_until TEXT,updated_at TEXT);
CREATE TABLE record_teacher_settings(teacher_id TEXT,revision INT,style TEXT,opens_at TEXT,deadline_at TEXT,spreadsheet_id TEXT,folder_id TEXT);
CREATE TABLE record_drafts(student_id TEXT PRIMARY KEY,teacher_id TEXT,revision INT,source_revision INT,course1 TEXT,course2 TEXT,notes TEXT,checked_groups TEXT,evidence TEXT,ai_result TEXT,status TEXT,updated_at TEXT);
CREATE TABLE record_draft_versions(id TEXT,student_id TEXT,revision INT,snapshot TEXT,created_by TEXT,created_at TEXT);
CREATE TABLE record_submission_versions(id TEXT,student_id TEXT,revision INT,snapshot TEXT,created_by TEXT,created_at TEXT);
CREATE TABLE record_files(id TEXT,student_id TEXT,activity TEXT,course INT,file_name TEXT,mime_type TEXT,byte_size INT,revision INT,extraction_status TEXT,extracted_text TEXT,extraction_note TEXT,drive_status TEXT,created_at TEXT,included INT);
CREATE TABLE teams(id TEXT,class_id TEXT,name TEXT);
CREATE TABLE inquiry_sessions(id TEXT,team_id TEXT);
CREATE TABLE team_members(user_id TEXT,team_id TEXT,joined_at TEXT,left_at TEXT);
CREATE TABLE experiment_journals(id TEXT,session_id TEXT,student_id TEXT,journal_date TEXT,activities TEXT,observations TEXT,reflections TEXT);
CREATE TABLE experiment_journal_images(id TEXT,journal_id TEXT,file_name TEXT,image_data BLOB);
CREATE TABLE messages(id TEXT,session_id TEXT,sender_id TEXT,role TEXT,content TEXT,created_at TEXT);
CREATE TABLE discussion_entries(id TEXT,session_id TEXT,author_id TEXT,content TEXT,kind TEXT,created_at TEXT);
CREATE TABLE exam_sets(id TEXT,class_id TEXT,title TEXT);
CREATE TABLE exams(id TEXT,exam_set_id TEXT,student_id TEXT);
CREATE TABLE exam_results(exam_id TEXT,teacher_feedback TEXT);
CREATE TABLE audit_logs(id TEXT,actor_id TEXT,action TEXT,entity_type TEXT,entity_id TEXT,detail TEXT);
INSERT INTO classes VALUES('c9',2026,9),('c8',2026,8);
INSERT INTO users(id,name,login_id,role,is_master) VALUES('teacher','synthetic','synthetic-t','teacher',0),('outsider','synthetic','synthetic-o','teacher',1);
INSERT INTO users(id,name,login_id,role,class_id) VALUES('owner','synthetic','synthetic-s','student','c9'),('peer','synthetic','synthetic-p','student','c9');
INSERT INTO record_teacher_classes VALUES('c9','teacher');
INSERT INTO class_journal_teacher_assignments VALUES('c9','teacher'),('c9','outsider');
INSERT INTO teams VALUES('team9','c9','synthetic'),('team8','c8','synthetic old');
INSERT INTO inquiry_sessions VALUES('session9','team9'),('session8','team8');
INSERT INTO experiment_journals VALUES('own','session9','owner','2026-10-21','OWNER_SECRET','observation','reflection'),('peer-journal','session9','peer','2026-10-21','PEER_SECRET','','');
INSERT INTO experiment_journal_images VALUES('photo','own','synthetic.png',X'010203');
`);
const query = async (sql, values=[]) => {
  const args=[];
  const converted=sql.replace(/^BEGIN ISOLATION LEVEL READ COMMITTED$/,'BEGIN').replace(/ FOR (UPDATE|SHARE)\b/g,'').replace(/\$(\d+)/g,(_, n)=>{ args.push(values[Number(n)-1]); return '?'; });
  const stmt=sqlite.prepare(converted);
  if (/^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) return { rows: stmt.all(...args).map(r=>({...r})) };
  stmt.run(...args); return {rows:[]};
};
const db={query,connect:async()=>({query,release(){}})};
let currentUser;
const context=vm.createContext({console,Buffer,TextEncoder,URL,Request,Response,Headers,AbortSignal,process:{env:{ACADEMIC_YEAR:'2026'}},setTimeout,clearTimeout});
const modules=new Map();
let chain;
chain=new Proxy(function(){return chain;},{get:(_,key)=>key==='parse' ? value=>value : chain});
class ZodError extends Error {}
const fixtures={
  '@/lib/db':{getDb:async()=>db}, '@/lib/auth':{getCurrentUser:async()=>currentUser},
  '@/lib/master-accounts':{assertMasterActor:async()=>{throw new Error('Not exercised');}},
  'zod':{z:chain,ZodError}, 'next/server':{NextResponse:Response}, 'node:crypto':crypto,
};
async function moduleFor(spec, parent=resolve(root,'entry.ts')) {
  if (fixtures[spec]) {
    if (!modules.has(spec)) {
      const values=fixtures[spec];
      modules.set(spec,new vm.SyntheticModule(Object.keys(values),function(){ for(const [k,v] of Object.entries(values))this.setExport(k,v); },{context,identifier:spec}));
    }
    return modules.get(spec);
  }
  const path=spec.startsWith('@/') ? resolve(root,'src',spec.slice(2)+'.ts') : resolve(dirname(parent),spec.endsWith('.ts') ? spec : spec+'.ts');
  if (modules.has(path)) return modules.get(path);
  const code=stripTypeScriptTypes(readFileSync(path,'utf8'),{mode:'transform'});
  const mod=new vm.SourceTextModule(code,{context,identifier:path}); modules.set(path,mod);
  await mod.link((next, referring)=>moduleFor(next,referring.identifier));
  return mod;
}
async function load(spec){const mod=await moduleFor(spec);if(mod.status!=='evaluated')await mod.evaluate();return mod.namespace;}
const access=await load('@/lib/student-records/access');
const evidence=await load('@/lib/student-records/evidence');
const service=await load('@/lib/student-records/service');
const settings=await load('@/lib/journal-teacher-settings');
const route=await load('@/app/api/records/journal-images/[imageId]/route');
const teacher={id:'teacher',role:'teacher',mustChangePassword:false};
const owner={id:'owner',role:'student',mustChangePassword:false};
const peer={...owner,id:'peer'}, outsider={...teacher,id:'outsider'};
const checks=[];
async function check(name,fn){await fn();checks.push(name);}
async function photo(actor){currentUser=actor;return route.GET(new Request('https://synthetic.invalid/api/records/journal-images/photo'),{params:Promise.resolve({imageId:'photo'})});}
await check('authorized evidence excludes peer journals',async()=>{
  const result=await evidence.collectRecordEvidence(db,teacher,owner.id);
  assert.match(JSON.stringify(result),/OWNER_SECRET/);assert.doesNotMatch(JSON.stringify(result),/PEER_SECRET/);
  const workspace=await service.getRecordWorkspace(teacher,owner.id);
  await service.saveRecordDraft(teacher,owner.id,{expectedRevision:0,expectedSubmissionRevision:0,expectedEvidenceHash:workspace.evidence.hash,course1:'synthetic',course2:'DERIVED_SECRET',notes:'PRIVATE_NOTE',checkedGroups:[],finalize:false});
  assert.equal((await photo(teacher)).status,200);
});
await check('master and shared grant cannot bypass records assignment',async()=>{
  await assert.rejects(()=>service.getRecordWorkspace(outsider,owner.id),{status:403});
  assert.equal((await photo(outsider)).status,403);
});
await check('non-master teacher cannot mutate grants',async()=>{
  await assert.rejects(()=>settings.setJournalTeacherClasses(teacher.id,teacher.id,[],['c9']),/활성 마스터/);
});
const before=JSON.stringify((await query('SELECT * FROM record_drafts')).rows);
await settings.setJournalTeacherClasses(outsider.id,teacher.id,[],['c9']);
await check('actual settings revocation denies fresh evidence',async()=>{
  await assert.rejects(()=>evidence.collectRecordEvidence(db,teacher,owner.id),{status:403});
});
await check('revocation denies saved prose and history without deleting rows',async()=>{
  await assert.rejects(()=>service.getRecordWorkspace(teacher,owner.id),{status:403});
  await assert.rejects(()=>service.recordHistory(teacher,owner.id),{status:403});
  assert.equal(JSON.stringify((await query('SELECT * FROM record_drafts')).rows),before);
  assert.equal((await query('SELECT * FROM record_draft_versions')).rows.length,1);
  await assert.rejects(()=>service.saveRecordDraft(teacher,owner.id,{expectedRevision:1,expectedSubmissionRevision:0,expectedEvidenceHash:'0'.repeat(64),course1:'denied',course2:'denied',notes:'',checkedGroups:[],finalize:false}),{status:403});
  assert.equal(JSON.stringify((await query('SELECT * FROM record_drafts')).rows),before);
});
await check('photo denial preserves owner access and excludes peer',async()=>{
  assert.equal((await photo(teacher)).status,403);assert.equal((await photo(owner)).status,200);assert.equal((await photo(peer)).status,403);
});
await check('revoked teacher disappears from records roster',async()=>{
  assert.equal((await access.teacherRecordStudents(teacher)).length,0);
});
await settings.setJournalTeacherClasses(outsider.id,teacher.id,['c9'],[]);
await check('explicit regrant restores preserved teacher draft',async()=>{
  assert.equal((await service.getRecordWorkspace(teacher,owner.id)).draft.course2,'DERIVED_SECRET');
});
await check('photo permission is rechecked after reading bytes',async()=>{
  db.query=async(sql,values)=>{
    const result=await query(sql,values);
    if(sql.startsWith('SELECT image_data, file_name')) await query("DELETE FROM class_journal_teacher_assignments WHERE teacher_id='teacher'");
    return result;
  };
  try { assert.equal((await photo(teacher)).status,403); }
  finally { db.query=query; await query("INSERT INTO class_journal_teacher_assignments VALUES('c9','teacher')"); }
});
await query("INSERT INTO experiment_journals VALUES('old','session8','owner','2026-09-01','OLD_CLASS_SECRET','','')");
await check('source class restriction and unresolved provenance fail closed',async()=>{
  assert.doesNotMatch(JSON.stringify(await evidence.collectRecordEvidence(db,teacher,owner.id)),/OLD_CLASS_SECRET/);
  for(const sources of [null,{sources:[{id:'journal:old'}]},{sources:[{id:'journal:missing'}]}]) await assert.rejects(()=>access.assertRecordEvidenceAccess(db,teacher,owner.id,sources),{status:403});
  await query('UPDATE record_drafts SET evidence=$1',[JSON.stringify({sources:[{id:'journal:old'}]})]);
  const fresh=await service.getRecordWorkspace(teacher,owner.id);
  assert.equal(fresh.draft.previousDraftHidden,true);assert.equal(fresh.draft.course2,'');
  await query('UPDATE record_draft_versions SET snapshot=$1',[JSON.stringify({evidence:{sources:[{id:'journal:old'}]},notes:'DERIVED_OLD_SECRET'})]);
  assert.equal((await service.recordHistory(teacher,owner.id)).drafts.length,0);
  const preserved=(await query('SELECT * FROM record_drafts')).rows[0];
  const versions=JSON.stringify((await query('SELECT * FROM record_draft_versions')).rows);
  const input={expectedRevision:fresh.draft.revision,expectedSubmissionRevision:fresh.submission.revision,expectedEvidenceHash:fresh.evidence.hash,course1:'new',course2:'CURRENT_ONLY',notes:'',checkedGroups:[],finalize:false};
  await assert.rejects(()=>service.saveRecordDraft(teacher,owner.id,input),{status:409});
  const saved=await service.saveRecordDraft(teacher,owner.id,{...input,startNewDraft:true});
  const after=(await query('SELECT * FROM record_draft_versions ORDER BY revision')).rows;
  assert.equal(JSON.stringify(after.slice(0,1)),versions);
  assert.deepEqual(JSON.parse(after[1].snapshot).preservedDraft,preserved);
  assert.equal(saved.revision,preserved.revision+2);
  assert.equal((await service.recordHistory(teacher,owner.id)).drafts.length,1);
  assert.equal((await service.getRecordWorkspace(teacher,owner.id)).draft.course2,'CURRENT_ONLY');
});
// Synthetic Google transports exercise real request/auth/batch ordering. The
// SQLite adapter cannot prove PostgreSQL row-lock behavior; see postgres suite.
const headers=()=>new Headers({authorization:'Bearer synthetic-only'});
let prepareHeaders=async()=>headers();
fixtures['google-auth-library']={
  GoogleAuth:class {async getClient(){return {getRequestHeaders:()=>prepareHeaders()};}},
  OAuth2Client:class {setCredentials(){} getRequestHeaders(){return prepareHeaders();}},
};
fixtures['./files']={getRecordFile:async()=>{throw Error('unused');},uploadRecordFile:async()=>{throw Error('unused');}};
fixtures['./extraction']={RECORD_FILE_MAX_BYTES:10*1024*1024};
context.process.env.GOOGLE_SERVICE_ACCOUNT_JSON='{}';
const google=await load('@/lib/student-records/google');
await query("INSERT INTO record_teacher_settings(teacher_id,spreadsheet_id) VALUES('teacher','synthetic-sheet')");
for(const actor of [owner,peer]){
  const w=await service.getRecordWorkspace(teacher,actor.id);
  await service.saveRecordDraft(teacher,actor.id,{expectedRevision:w.draft.revision,expectedSubmissionRevision:w.submission.revision,expectedEvidenceHash:w.evidence.hash,course1:'CURRENT_PUBLIC_TO_TEACHER',course2:'synthetic final',notes:'synthetic missing evidence reviewed',checkedGroups:['team_plan','journal','team_report','exam'],finalize:true});
}
let writes=0;
const syntheticFetch=async(url,init)=>{
  if(init?.method==='PUT'){writes++;return Response.json({updatedRows:3});}
  if(url.includes(':batchUpdate'))return Response.json({replies:[{addSheet:{properties:{sheetId:7}}}]});
  return Response.json({sheets:[]});
};
context.fetch=syntheticFetch;
await check('delayed Google auth cannot send any student after revocation',async()=>{
  let calls=0;
  const ready=Promise.withResolvers(), resume=Promise.withResolvers();
  prepareHeaders=async()=>{if(++calls===3){ready.resolve();await resume.promise;}return headers();};
  const pending=google.exportTeacherRecords(teacher,'synthetic-auth-delay-1').then(value=>({value}),error=>({error}));
  await ready.promise;
  await settings.setJournalTeacherClasses(outsider.id,teacher.id,[],['c9']);
  resume.resolve();
  assert.equal((await pending).error?.status,403);assert.equal(writes,0);
  await settings.setJournalTeacherClasses(outsider.id,teacher.id,['c9'],[]);
  prepareHeaders=async()=>headers();
});
await check('all students are checked in one locked transaction before one PUT',async()=>{
  const trace=[];
  const connect=db.connect;
  db.connect=async()=>({release(){trace.push('release');},query:async(sql,values)=>{
    trace.push(sql.startsWith('BEGIN')?'BEGIN':sql==='COMMIT'?sql:sql.includes('FOR SHARE')?sql:sql.includes('FROM users s JOIN')?'checked:'+values[0]:'query');
    return query(sql,values);
  }});
  context.fetch=async(url,init)=>{
    if(init?.method==='PUT'){
      trace.push('PUT');
      assert.equal(JSON.parse(init.body).values.length,3);
      const guarded=trace.slice(trace.lastIndexOf('BEGIN'));
      assert.match(guarded[1],/classes.*FOR SHARE/);
      assert.ok(guarded.includes('checked:owner'));assert.ok(guarded.includes('checked:peer'));
      assert.ok(guarded.some(x=>x.includes('class_journal_teacher_assignments')&&x.includes('FOR SHARE')));
    }
    return syntheticFetch(url,init);
  };
  try{
    const result=await google.exportTeacherRecords(teacher,'synthetic-batch-send-2');
    assert.equal(result.count,2);
    assert.deepEqual(trace.slice(trace.indexOf('PUT')+1),['COMMIT','release']);
  }finally{db.connect=connect;context.fetch=syntheticFetch;}
});
console.log(JSON.stringify({status:'passed',checks,limitations:['SQLite, not PostgreSQL','schema validation and Next response helpers stubbed','no browser, AI or Google connections']},null,2));
sqlite.close();
