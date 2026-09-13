import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createLocalTestDb } from "./local-postgres-test-env.mjs";
const { app, root } = await createLocalTestDb("plan_review_race");
globalThis.fetch = async () => { throw new Error("External network disabled"); };
const { ensureInitialCycle } = await import("../src/lib/inquiry-cycles.ts");
const { createPlanSubmission } = await import("../src/lib/plan-snapshots.ts");
const { requestStudentPlanAiReview, requestTeacherPlanAiReview } = await import("../src/lib/plan-ai-review.ts");
const settle = p => p.then(value => ({ok:true,value}), () => ({ok:false}));
const connect = app.connect.bind(app);
let gate;
app.connect = (...args) => args.length ? connect(...args) : (async () => {
  const client = await connect(), query = client.query.bind(client), release = client.release.bind(client);
  client.query = async (...args) => {
    if (gate && !gate.used && String(args[0]).includes("INSERT INTO plan_ai_reviews")) {
      gate.used = true; gate.pid = (await query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      gate.reached(); await gate.pause;
    }
    return query(...args);
  };
  client.release = (...args) => { client.query=query; client.release=release; return release(...args); };
  return client;
})();
const results=[];
try {
  for (const audience of ["student","teacher"]) for (const kind of ["inactive","password","archive","completed", audience === "student" ? "membership" : "assignment"]) for (const first of ["change","save"]) {
    const key=`race_${audience}_${kind}_${first}`, actor=`${key}_actor`;
    await app.query("INSERT INTO users(id,name,login_id,academic_year,role,password_hash,must_change_password,is_master) VALUES($1,'합성 검토자',$1,2026,$2,'unused',FALSE,FALSE)",[actor,audience]);
    await app.query("INSERT INTO clubs(id,academic_year,name,created_by) VALUES($1,2026,'합성 동아리','teacher_bootstrap')",[key]);
    await app.query("INSERT INTO teams(id,club_id,team_number,name,leader_user_id) VALUES($1,$1,1,'합성 팀',$2)",[key,actor]);
    await app.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$1,$2)",[key,actor]);
    if(audience==='teacher') await app.query("INSERT INTO club_teacher_assignments(club_id,teacher_id,assigned_by) VALUES($1,$2,'teacher_bootstrap')",[key,actor]);
    await app.query("INSERT INTO inquiry_sessions(id,team_id,stage) VALUES($1,$1,'PLANNING')",[key]);
    const cycle=await ensureInitialCycle(app,key,'teacher_bootstrap'), source={topic:'합성 주제',method:'측정'};
    await app.query("INSERT INTO investigation_plans(id,session_id,cycle_id,form_data,review_status) VALUES($1,$1,$2,$3,'pending')",[key,cycle,JSON.stringify(source)]);
    if(audience==='teacher') await createPlanSubmission(app,key,actor);
    const change=()=>kind==='inactive'?app.query("UPDATE users SET status='inactive' WHERE id=$1",[actor])
      :kind==='password'?app.query("UPDATE users SET must_change_password=TRUE WHERE id=$1",[actor])
      :kind==='archive'?app.query("UPDATE teams SET status='archived' WHERE id=$1",[key])
      :kind==='completed'?app.query("UPDATE inquiry_cycles SET status='completed' WHERE id=$1",[cycle])
      :app.query("DELETE FROM club_teacher_assignments WHERE club_id=$1",[key]);
    const mutate=async()=>{
      if(kind!=='membership') return change();
      const c=await app.connect();
      try { await c.query('BEGIN'); await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[actor]); await c.query('SELECT id FROM teams WHERE id=$1 FOR UPDATE',[key]); await c.query("UPDATE team_members SET status='inactive',left_at=CURRENT_TIMESTAMP WHERE id=$1",[key]); await c.query('COMMIT'); }
      catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
    };
    let reached,resume;
    const ready=new Promise(r=>reached=r),pause=new Promise(r=>resume=r);
    gate=first==='save'?{used:false,reached,pause}:null;
    const request=audience==='student'?requestStudentPlanAiReview:requestTeacherPlanAiReview;
    const writing=settle(request(key,actor,async()=>{
      if(first==='change') await mutate();
      return {model:'synthetic-no-network',result:{readiness:'needs_revision',summary:'합성 결과',strengths:[],checks:[],limitations:[]}};
    }));
    let changing,waited=false;
    if(first==='save'){
      const timer=setTimeout(resume,15000);
      try{
        await Promise.race([ready,writing.then(()=>{throw new Error('gate not reached');})]);
        changing=settle(mutate());
        const deadline=Date.now()+7000;
        while(Date.now()<deadline){
          if((await app.query("SELECT pid FROM pg_stat_activity WHERE wait_event_type='Lock' AND $1::int=ANY(pg_blocking_pids(pid))",[gate.pid])).rows.length){waited=true;break;}
          await new Promise(r=>setTimeout(r,40));
        }
        assert.ok(waited);
      }finally{clearTimeout(timer);resume();}
    }
    const written=await writing; if(changing)assert.equal((await changing).ok,true); gate=null;
    assert.equal(written.ok,first==='save');
    const rows=(await app.query('SELECT id FROM plan_ai_reviews WHERE requested_by=$1',[actor])).rows;
    assert.equal(rows.length,first==='save'?1:0);
    assert.equal((await settle(request(key,actor))).ok,false);
    assert.deepEqual((await app.query('SELECT form_data FROM investigation_plans WHERE id=$1',[key])).rows[0].form_data,source);
    assert.equal((await app.query('SELECT id FROM team_members WHERE id=$1',[key])).rowCount,1);
    results.push({audience,kind,first,passed:true,waited});
  }
  await writeFile(new URL('plan-review-race-77.json',root),JSON.stringify({syntheticOnly:true,results},null,2));
  console.log(JSON.stringify({passed:results.length,lockWaits:results.filter(r=>r.waited).length}));
} finally { await app.end(); }
