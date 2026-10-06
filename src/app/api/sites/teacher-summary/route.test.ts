import {beforeEach,describe,it,expect,vi} from "vitest";
const mocks=vi.hoisted(()=>({current:vi.fn(),dashboard:vi.fn()}));
vi.mock("@/lib/auth",()=>({getCurrentUser:mocks.current}));vi.mock("@/lib/teacher-data",()=>({getTeacherDashboardData:mocks.dashboard}));
import {GET} from "./route";
describe("read-only teacher Sites summary",()=>{
 beforeEach(()=>{vi.stubEnv("SITES_PILOT_ENABLED","true");mocks.current.mockReset();mocks.dashboard.mockReset();});
 it("denies students and forced password change accounts before querying dashboards",async()=>{for(const user of [null,{role:"student"},{role:"teacher",mustChangePassword:true}]){mocks.current.mockResolvedValue(user);expect((await GET()).status).toBe(403);}expect(mocks.dashboard).not.toHaveBeenCalled();});
 it("is disabled by default",async()=>{vi.stubEnv("SITES_PILOT_ENABLED","false");expect((await GET()).status).toBe(404);expect(mocks.current).not.toHaveBeenCalled();});
 it("omits student identities and clearly reports unavailable cost/credits",async()=>{mocks.current.mockResolvedValue({role:"teacher",mustChangePassword:false});mocks.dashboard.mockResolvedValue({counts:{students:270,teams:54},students:[{name:"private-name"}],teams:[{id:"x",name:"1조",classNumber:1,memberCount:5,messageCount:3,journalEntryCount:2,planStatus:"draft",lastActivityAt:null,leaderUserId:"private-id"}]});const res=await GET();const data=await res.json();expect(JSON.stringify(data)).not.toContain("private-");expect(data.usage.costUsd).toBeNull();expect(data.scope).toBe("standard-school");});
});
