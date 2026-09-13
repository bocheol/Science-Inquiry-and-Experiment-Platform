import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ generate: vi.fn(), send: vi.fn(), access: vi.fn(), user: vi.fn(), query: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/inquiry-data", () => ({ assertActiveTeamMember: mocks.access }));
vi.mock("@/lib/db", () => ({ getDb: async () => ({ query: mocks.query }) }));
vi.mock("@/lib/ai", () => ({ generateTopicSuggestions: mocks.generate, sendTeamMessage: mocks.send, userFacingAiError: () => "failed" }));
import { POST as topic } from "@/app/api/inquiry/topic-suggestions/route";
import { POST as message } from "@/app/api/inquiry/messages/route";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.user.mockResolvedValue({ id: "student", role: "student", mustChangePassword: false });
  mocks.access.mockResolvedValue("team");
  mocks.query.mockResolvedValue({ rows: [{ id: "student" }] });
});
const request = (body: object) => new Request("http://localhost/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
it.each([topic, message])("requires the displayed cycle before performing any AI work", async handler => {
  expect((await handler(request({ sessionId: "session", interest: "관심사", content: "질문" }))).status).toBe(400);
  expect(mocks.access).not.toHaveBeenCalled();
  expect(mocks.generate).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
});
it("passes the displayed cycle to topic generation", async () => {
  expect((await topic(request({ sessionId: "session", cycleId: "cycle", interest: "관심사" }))).status).toBe(200);
  expect(mocks.generate).toHaveBeenCalledWith("session", "team", "관심사", "student", undefined, "cycle");
});
it("passes the displayed cycle to chat generation", async () => {
  expect((await message(request({ sessionId: "session", cycleId: "cycle", content: "질문" }))).status).toBe(200);
  expect(mocks.send).toHaveBeenCalledWith("session", "team", { id: "student", alias: "팀원 A" }, "질문", undefined, "cycle");
});
