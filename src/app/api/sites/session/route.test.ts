import {beforeEach,describe,it,expect,vi} from "vitest";
const current=vi.hoisted(()=>vi.fn());vi.mock("@/lib/auth",()=>({getCurrentUser:current}));
import {GET} from "./route";
describe("opt-in Sites session adapter",()=>{
 beforeEach(()=>{vi.stubEnv("SITES_PILOT_ENABLED","false");current.mockReset();});
 it("is inert by default, without accessing auth or the database",async()=>{expect((await GET()).status).toBe(404);expect(current).not.toHaveBeenCalled();});
 it("requires the existing authenticated session",async()=>{vi.stubEnv("SITES_PILOT_ENABLED","true");current.mockResolvedValue(null);expect((await GET()).status).toBe(401);});
 it("returns minimal profile, honors forced password changes and advertises no invented credit control",async()=>{vi.stubEnv("SITES_PILOT_ENABLED","true");current.mockResolvedValue({id:"test",name:"합성 학생",role:"student",classNumber:1,mustChangePassword:true,loginId:"never-return",passwordHash:"never-return"});const res=await GET();const data=await res.json();expect(data.user.mustChangePassword).toBe(true);expect(data.user.loginId).toBeUndefined();expect(data.user.passwordHash).toBeUndefined();expect(data.capabilities.monthlyBudget).toBe(false);expect(res.headers.get("Cache-Control")).toBe("no-store");});
});
