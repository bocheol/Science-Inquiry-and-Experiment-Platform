import {expect,it} from "vitest";
import {getDb} from "@/lib/db";
import {createAnnouncement} from "@/lib/notices";
import {savePushSubscription,removePushSubscription,sendPushForNotice} from "@/lib/push-notifications";
import type {SessionUser} from "@/lib/types";

it("excludes demo/inactive/unsubscribed recipients and applies removed membership only to team notices",async()=>{
  const db=await getDb(),teamId="push_audience_team";
  await db.query("INSERT INTO teams (id,class_id,team_number,name) VALUES ($1,'class_2026_9',195,'합성 수신 팀')",[teamId]);
  const actors:Record<string,SessionUser>={};
  for(const kind of ["eligible","demo","inactive","removed"]) {
    const id="push_audience_"+kind;
    await db.query("INSERT INTO users (id,name,login_id,academic_year,role,class_id,password_hash,account_type,must_change_password) VALUES ($1,$1,$1,2026,'student','class_2026_9','unused',$2,FALSE)",[id,kind==="demo"?"demo":"standard"]);
    await db.query("INSERT INTO team_members (id,team_id,user_id,status) VALUES ($1,$2,$1,$3)",[id,teamId,kind==="removed"?"inactive":"active"]);
    actors[kind]={id,name:id,loginId:id,academicYear:2026,role:"student",classId:"class_2026_9",classNumber:9,mustChangePassword:false,accountType:kind==="demo"?"demo":"standard"};
    await savePushSubscription(actors[kind],{endpoint:`https://push.example/${kind}`,keys:{p256dh:"p".repeat(80),auth:"a".repeat(24)}},"synthetic");
  }
  await db.query("UPDATE users SET status = 'inactive' WHERE id = 'push_audience_inactive'");
  const teacher={id:"teacher_bootstrap",role:"teacher",academicYear:2026,mustChangePassword:false} as SessionUser;
  for(const audienceType of ["all","class","team"] as const) {
    const notice=await createAnnouncement(teacher,{title:"합성 대상 점검",content:"합성 안내",audienceType,classNumber:audienceType==="class"?9:undefined,teamId:audienceType==="team"?teamId:undefined,priority:"normal"});
    const delivered:string[]=[];
    await sendPushForNotice(notice,async subscription=>{delivered.push(subscription.endpoint);});
    expect(delivered.sort()).toEqual((audienceType==="team"?["https://push.example/eligible"]:["https://push.example/eligible","https://push.example/removed"]).sort());
    if(audienceType==="team") {
      await removePushSubscription(actors.eligible,"https://push.example/eligible");
      expect(await sendPushForNotice(notice,async()=>{throw new Error("Unexpected recipient");})).toMatchObject({targeted:0});
    }
  }
});
