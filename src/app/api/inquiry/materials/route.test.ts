import { beforeEach, expect, it, vi } from "vitest";
import { UserFacingError } from "@/lib/user-facing-error";
const mocks = vi.hoisted(() => ({ save: vi.fn(), member: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: async () => ({ id: "synthetic-student", role: "student", mustChangePassword: false }) }));
vi.mock("@/lib/inquiry-data", () => ({ assertActiveTeamMember: mocks.member }));
vi.mock("@/lib/materials", () => ({ saveAndSyncMaterials: mocks.save }));
import { POST } from "@/app/api/inquiry/materials/route";
const body = { submissionId: "synthetic-material-request", sessionId: "session", items: [{ name: "합성 비커", specification: "", unitPrice: 0, quantity: 1, shipping: 0, link: "" }] };
const request = (data: unknown) => new Request("http://localhost/api/inquiry/materials", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
beforeEach(() => {
  mocks.member.mockReset().mockResolvedValue("synthetic-team");
  mocks.save.mockReset().mockResolvedValue({ syncStatus: "pending" });
});
it("rejects a legacy request without a cycle before saving", async () => {
  expect((await POST(request(body))).status).toBe(400);
  expect(mocks.save).not.toHaveBeenCalled();
});
it("passes the displayed cycle to the save boundary", async () => {
  expect((await POST(request({ ...body, cycleId: "displayed-cycle" }))).status).toBe(200);
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ cycleId: "displayed-cycle", actorId: "synthetic-student", teamId: "synthetic-team" }));
});

it("accepts prices and shipping above the former monetary caps", async () => {
  const items = [{ ...body.items[0], unitPrice: 3_000_000_000, shipping: 20_000_000 }];
  expect((await POST(request({ ...body, cycleId: "displayed-cycle", items }))).status).toBe(200);
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ items }));
});

it("hides unexpected storage details and preserves explicit material guidance", async () => {
  mocks.save.mockRejectedValueOnce(new Error("postgresql://internal:secret@private/materials"));
  const failed = await POST(request({ ...body, cycleId: "displayed-cycle" }));
  expect(await failed.json()).toEqual({ message: "준비물을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요." });

  const guidance = "탐구 회차가 변경되었습니다. 작성 내용을 보관하고 현재 회차를 다시 확인해 주세요.";
  mocks.save.mockRejectedValueOnce(new UserFacingError(guidance));
  const expected = await POST(request({ ...body, cycleId: "displayed-cycle" }));
  expect(await expected.json()).toEqual({ message: guidance });
});
