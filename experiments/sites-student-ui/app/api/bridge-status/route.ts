import {env} from "cloudflare:workers";
import {bridgeStatus} from "@/lib/pilot-bridge.mts";
export const dynamic="force-dynamic";
export function GET(){const v=env as unknown as Record<string,string|undefined>;return Response.json(bridgeStatus({origin:v.PILOT_BACKEND_ORIGIN||"",mode:v.PILOT_BACKEND_MODE||"production-readonly",allowWrites:v.PILOT_ALLOW_WRITES==="yes"}),{headers:{"Cache-Control":"no-store"}});}
