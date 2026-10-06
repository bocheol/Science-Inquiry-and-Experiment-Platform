import assert from "node:assert/strict";
import {createBridge,relayCookie,bridgeStatus} from "../lib/pilot-bridge.mts";
const prod={origin:"https://science-inquiry-platform-974188506094.asia-northeast3.run.app",mode:"production-readonly",allowWrites:true};
const stage={origin:"https://synthetic-staging.test",mode:"staging",allowWrites:true};
let calls=0,lastHeaders=new Headers();
const mock:typeof fetch=async (_url,init)=>{calls++;lastHeaders=new Headers(init?.headers);return Response.json({ok:true},{headers:{"Set-Cookie":"science_inquiry_session=synthetic.jwt.value; Domain=upstream.test; Path=/api; HttpOnly; SameSite=Lax; Max-Age=86400"}});};
const bridge=createBridge(mock);
const req=(method="GET",extra:Record<string,string>={},body?:string)=>new Request("https://pilot.test/api/bridge/test",{method,headers:{origin:"https://pilot.test","content-type":"application/json",...extra},body});
assert.equal(bridgeStatus(prod).canWrite,false);assert.equal(bridgeStatus({...prod,mode:"staging"}).configured,false);
for(const action of ["login","logout","password","topic","plan","lock","journals"]){assert.equal((await bridge(req("POST",{},"{}"),action,prod)).status,423);}
for(const action of ["topics","chat"]){assert.equal((await bridge(req("POST",{},"{}"),action,stage)).status,423);}
assert.equal(calls,0);
assert.equal((await bridge(req("POST",{origin:"https://evil.test"},"{}"),"login",stage)).status,403);
assert.equal((await bridge(req("GET"),"https://evil.test",stage)).status,404);
assert.equal((await bridge(req("GET"),"health",{...stage,origin:"http://localhost"})).status,503);
assert.equal((await bridge(req("GET"),"health",{...stage,origin:"https://user:pass@remote.test"})).status,503);
assert.equal((await bridge(new Request("https://pilot.test/api?url=https://evil.test"),"inquiry",stage)).status,400);
assert.equal((await bridge(req("POST",{},"x".repeat(65537)),"login",stage)).status,413);
assert.equal((await bridge(req("POST",{"content-type":"text/plain"},"{}"),"login",stage)).status,415);
const result=await bridge(req("GET",{cookie:"other=secret; science_inquiry_session=synthetic.jwt.value","oai-authenticated-user-id":"attacker",authorization:"Bearer forged"}),"health",stage);
assert.equal(result.status,200);assert.equal(lastHeaders.get("cookie"),"science_inquiry_session=synthetic.jwt.value");assert.equal(lastHeaders.get("authorization"),null);assert.equal(lastHeaders.get("oai-authenticated-user-id"),null);
const cookie=result.headers.get("set-cookie")!;assert.ok(cookie.includes("SameSite=Strict"));assert.ok(cookie.includes("Secure"));assert.ok(cookie.includes("HttpOnly"));assert.ok(!cookie.includes("Domain="));assert.ok(!cookie.includes("Path=/api"));
assert.equal(relayCookie("not_the_session=token"),null);assert.equal(relayCookie("science_inquiry_session=; Max-Age=0")?.endsWith("Max-Age=0"),true);
assert.equal((await createBridge(async()=>new Response("html",{status:302,headers:{location:"https://evil.test"}}))(req(),"health",stage)).status,502);
assert.equal((await createBridge(async()=>new Response("x".repeat(2*1024*1024+1),{headers:{"content-type":"application/json"}}))(req(),"health",stage)).status,413);
// 60 simultaneous synthetic requests, never a load test on production.
const limited=createBridge(async()=>{await new Promise(r=>setTimeout(r,15));return Response.json({ok:true});},8);
const results=await Promise.all(Array.from({length:60},()=>limited(req(),"health",stage)));
assert.equal(results.filter(r=>r.status===200).length,8);assert.equal(results.filter(r=>r.status===429).length,52);
assert.equal((await limited(req(),"health",stage)).status,200);
console.log("PASS 24 bridge security/boundary assertions; 60 concurrent synthetic requests: 8 accepted, 52 bounded 429, slots released.");
