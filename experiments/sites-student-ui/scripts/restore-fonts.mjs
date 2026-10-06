import {readFile,writeFile,mkdir} from "node:fs/promises";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import path from "node:path";
const root=fileURLToPath(new URL("../",import.meta.url));
const manifest=JSON.parse(await readFile(path.join(root,"asset-source/fonts.json"),"utf8"));
const digest=bytes=>createHash("sha256").update(bytes).digest("hex");
for(const entry of manifest){
 const target=path.join(root,entry.file);
 let cached;try{cached=await readFile(target);}catch{}
 if(cached&&digest(cached)===entry.sha256)continue;
 const url=new URL(entry.url);
 if(url.origin!=="https://cdn.jsdelivr.net"||!url.pathname.startsWith("/npm/pretendard@1.3.9/"))throw new Error("Unapproved font source");
 const response=await fetch(url,{signal:AbortSignal.timeout(30000),redirect:"error"});
 if(!response.ok)throw new Error("Font fetch failed: "+response.status);
 const bytes=Buffer.from(await response.arrayBuffer());
 if(bytes.length>2*1024*1024||bytes.length!==entry.size||digest(bytes)!==entry.sha256)throw new Error("Font source integrity mismatch: "+entry.file);
 await mkdir(path.dirname(target),{recursive:true});await writeFile(target,bytes);
}
console.log("Verified Pretendard 1.3.9 font dependencies.");
