import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
const [base,phase]=process.argv.slice(2);
assert.ok(['https://astra77---science-inquiry-platform-mx3s6ovg6a-du.a.run.app','https://science-inquiry-platform-974188506094.asia-northeast3.run.app'].includes(base));
assert.ok(['staged','live'].includes(phase));
const results=[];
for(const [path,method,expected] of [['/api/health','GET',200],['/login','GET',200],['/manifest.webmanifest','GET',200],['/sw.js','GET',200],['/api/inquiry/plan-ai-review','POST',403],['/api/teacher/plans/ai-review','POST',403],['/api/teacher/clubs','GET',403],['/api/teacher/exams','GET',403]]){
 const response=await fetch(base+path,{method,redirect:'manual',signal:AbortSignal.timeout(120000)});
 results.push({path,method,status:response.status,expected});
 if(path==='/api/health'&&response.status===200)assert.equal((await response.json()).ok,true);
 else await response.arrayBuffer();
 assert.equal(response.status,expected,path);
}
await writeFile(new URL(`../output/test-infra/deploy-${phase}-smoke-77.json`,import.meta.url),JSON.stringify({base,phase,checkedAt:new Date().toISOString(),results},null,2));
console.log(JSON.stringify({phase,passed:results.length}));
