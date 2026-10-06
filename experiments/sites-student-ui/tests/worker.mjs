import {createRequire} from "node:module";
import {readdir} from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const require=createRequire(import.meta.url);
const {Miniflare}=require(createRequire(require.resolve("wrangler/package.json")).resolve("miniflare"));
const root=path.resolve("dist/server");
const files=(await readdir(root,{recursive:true})).filter(f=>f.endsWith(".js")||f.endsWith(".mjs"));
const modules=[{type:"ESModule",path:path.join(root,"index.js")},...files.filter(f=>f!=="index.js").map(f=>({type:"ESModule",path:path.join(root,f)}))];
const mf=new Miniflare({name:"inquiry-pilot-synthetic-qa",modules,modulesRoot:root,compatibilityDate:"2026-05-15",compatibilityFlags:["nodejs_compat"],bindings:{PILOT_BACKEND_ORIGIN:"https://science-inquiry-platform-974188506094.asia-northeast3.run.app",PILOT_BACKEND_MODE:"production-readonly",PILOT_ALLOW_WRITES:"no"},assets:{workerName:"inquiry-pilot-synthetic-qa",directory:path.resolve("dist/client"),binding:"ASSETS",routerConfig:{invoke_user_worker_ahead_of_assets:true,has_user_worker:true}},cf:false});
try{
 const page=await mf.dispatchFetch("https://pilot.test/");const html=await page.text();assert.equal(page.status,200);assert.ok(html.includes("탐구실에 들어가기"));assert.ok(html.includes("학생으로 체험하기"));assert.ok(html.includes('lang="ko"'));
 const status=await mf.dispatchFetch("https://pilot.test/api/bridge-status");const config=await status.json();assert.equal(config.configured,true);assert.equal(config.canWrite,false);assert.equal(config.canUseAi,false);
 for(const action of ["login","plan","journals","chat"]){const r=await mf.dispatchFetch(`https://pilot.test/api/bridge/${action}`,{method:"POST",headers:{origin:"https://pilot.test","content-type":"application/json"},body:"{}"});assert.equal(r.status,423);}
 const font=await mf.dispatchFetch("https://pilot.test/fonts/Pretendard-Regular.woff");assert.equal(font.status,200);
 console.log("PASS actual Worker SSR, Korean login labels, deployed bindings, production mutation/AI lock, font asset.");
 // Read-only live connectivity probe; never credentials, student records or paid AI.
 const health=await mf.dispatchFetch("https://pilot.test/api/bridge/health");console.log("LIVE_HEALTH",health.status,JSON.stringify(await health.json()));
}finally{await mf.dispose();}
