import {env} from "cloudflare:workers";
import {createBridge,type BridgeConfig} from "@/lib/pilot-bridge.mts";
const bridge=createBridge();
export const dynamic="force-dynamic";
async function handle(request:Request,context:{params:Promise<{action:string}>}) {
  const values=env as unknown as Record<string,string|undefined>;
  const config:BridgeConfig={origin:values.PILOT_BACKEND_ORIGIN||"",mode:values.PILOT_BACKEND_MODE||"production-readonly",allowWrites:values.PILOT_ALLOW_WRITES==="yes"};
  return bridge(request,(await context.params).action,config);
}
export const GET=handle;
export const POST=handle;
export const PATCH=handle;
