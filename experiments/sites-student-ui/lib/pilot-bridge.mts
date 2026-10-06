/** Finite, same-origin BFF. No database, OpenAI key, identity header or generic URL proxy. */
export type BridgeConfig = { origin: string; mode: string; allowWrites: boolean };
const COOKIE = "science_inquiry_session";
const PRODUCTION = "https://science-inquiry-platform-974188506094.asia-northeast3.run.app";
const routes: Record<string, {path:string; methods:string[]; query?:string[]; ai?:boolean; upload?:boolean}> = {
  health: {path:"/api/health",methods:["GET"]},
  session: {path:"/api/sites/session",methods:["GET"]},
  teacher: {path:"/api/sites/teacher-summary",methods:["GET"]},
  login: {path:"/api/auth/login",methods:["POST"]},
  logout: {path:"/api/auth/logout",methods:["POST"]},
  password: {path:"/api/auth/change-password",methods:["POST"]},
  inquiry: {path:"/api/inquiry",methods:["GET"],query:["team"]},
  topics: {path:"/api/inquiry/topic-suggestions",methods:["POST"],ai:true},
  topic: {path:"/api/inquiry/topic-select",methods:["POST"]},
  chat: {path:"/api/inquiry/messages",methods:["POST"],ai:true},
  plan: {path:"/api/inquiry/plan",methods:["PATCH","POST"]},
  lock: {path:"/api/inquiry/plan/lock",methods:["POST"]},
  journals: {path:"/api/inquiry/journals",methods:["GET","POST"],query:["sessionId","cycleId"],upload:true},
};
const json=(message:string,status:number)=>Response.json({message},{status,headers:{"Cache-Control":"no-store"}});
export function bridgeStatus(config:BridgeConfig) {
  return {configured:!!validOrigin(config),mode:config.mode,canWrite:!!validOrigin(config)&&config.mode==="staging"&&config.allowWrites&&config.origin!==PRODUCTION,canUseAi:false,pdfSupported:false};
}
function validOrigin(config:BridgeConfig) {
  try {
    const url=new URL(config.origin);
    if(url.protocol!=="https:"||url.username||url.password||url.pathname!=="/"||url.search||url.hash||url.port||/^(localhost|\d+\.|\[)/.test(url.hostname))return null;
    if(config.mode!=="production-readonly"&&config.mode!=="staging")return null;
    if(config.mode==="staging"&&url.origin===PRODUCTION)return null;
    return url.origin;
  }catch{return null;}
}
async function boundedBody(stream:ReadableStream<Uint8Array>|null,max:number) {
  if(!stream)return new Uint8Array();
  const reader=stream.getReader();const chunks:Uint8Array[]=[];let size=0;
  try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>max){await reader.cancel();throw new Error("body-limit");}chunks.push(value);}}
  finally {reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
export function relayCookie(raw:string) {
  const pair=raw.split(";",1)[0];
  if(!pair.startsWith(COOKIE+"="))return null;
  const value=pair.slice(COOKIE.length+1);if(!/^[A-Za-z0-9_.-]*$/.test(value))return null;
  const maxAge=/;\s*Max-Age=(\d+)/i.exec(raw)?.[1];
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${value?Math.min(Number(maxAge??86400),86400):0}`;
}
export function createBridge(fetcher:typeof fetch=fetch,capacity=8) {
  let active=0;
  return async (request:Request,action:string,config:BridgeConfig):Promise<Response>=>{
    const route=Object.hasOwn(routes,action)?routes[action]:undefined;if(!route||!route.methods.includes(request.method))return json("지원하지 않는 요청입니다.",404);
    const origin=validOrigin(config);if(!origin)return json("실험용 백엔드가 아직 연결되지 않았습니다.",503);
    const local=new URL(request.url);
    if(request.method!=="GET"&&(request.headers.get("origin")!==local.origin||request.headers.get("sec-fetch-site")==="cross-site"))return json("같은 사이트에서 다시 요청해 주세요.",403);
    if(route.ai)return json("서버 예산·크레딧 통제 확인 전에는 유료 AI 호출이 잠겨 있습니다.",423);
    if(request.method!=="GET"&&!bridgeStatus(config).canWrite)return json("운영 서버는 읽기 확인만 허용합니다. 별도 테스트 서버를 먼저 연결해 주세요.",423);
    if(active>=capacity)return new Response(JSON.stringify({message:"요청이 많습니다. 잠시 후 다시 시도해 주세요."}),{status:429,headers:{"Content-Type":"application/json","Retry-After":"3","Cache-Control":"no-store"}});
    const remote=new URL(route.path,origin);
    for(const [key,value] of local.searchParams){if(!route.query?.includes(key)||value.length>200)return json("조회 조건을 확인해 주세요.",400);remote.searchParams.set(key,value);}
    active++;
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),35_000);
    try {
      const headers=new Headers({Accept:"application/json"});
      // Only the existing signed session cookie crosses the boundary.
      const session=request.headers.get("cookie")?.split(";").map(v=>v.trim()).find(v=>v.startsWith(COOKIE+"="));
      if(session&&new RegExp(`^${COOKIE}=[A-Za-z0-9_.-]{1,8192}$`).test(session))headers.set("Cookie",session);
      let body:Uint8Array|undefined;
      if(request.method!=="GET") {
        const contentType=request.headers.get("content-type")||"";
        if(route.upload&&!contentType.startsWith("multipart/form-data; boundary="))return json("사진 첨부 형식을 확인해 주세요.",415);
        if(!route.upload&&!/^application\/json(?:;|$)/i.test(contentType))return json("JSON 요청이 필요합니다.",415);
        headers.set("Content-Type",contentType);
        body=await boundedBody(request.body,route.upload?6*1024*1024:64*1024);
      }
      const upstream=await fetcher(remote,{method:request.method,headers,body:body as BodyInit|undefined,redirect:"manual",signal:controller.signal,cache:"no-store"});
      const out=new Headers({"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});
      const getCookies=(upstream.headers as Headers&{getSetCookie?:()=>string[]}).getSetCookie?.();
      for(const raw of getCookies?.length?getCookies:[upstream.headers.get("set-cookie")||""]){const safe=relayCookie(raw);if(safe)out.append("Set-Cookie",safe);}
      if(action==="logout"&&upstream.status===303)return Response.json({ok:true},{headers:out});
      if(upstream.status>=300&&upstream.status<400)return json("서버 로그인 상태를 다시 확인해 주세요.",502);
      if(!(upstream.headers.get("content-type")||"").includes("application/json"))return json("백엔드 API 응답을 확인해 주세요.",502);
      const bytes=await boundedBody(upstream.body,2*1024*1024);
      return new Response(bytes as BodyInit,{status:upstream.status,headers:out});
    }catch(error) {
      if(error instanceof Error&&error.message==="body-limit")return json("요청 또는 응답 크기가 실험판 한도를 초과했습니다.",413);
      return json(controller.signal.aborted?"서버 응답 시간이 초과되었습니다. 저장 여부를 확인한 뒤 다시 시도해 주세요.":"백엔드 연결을 확인해 주세요.",controller.signal.aborted?504:502);
    }finally{clearTimeout(timer);active--;}
  };
}
