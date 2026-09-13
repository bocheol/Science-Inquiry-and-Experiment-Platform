import { beforeEach, expect, it, vi } from "vitest";
import { after } from "next/server";
import { deliverDiscussionPush } from "@/lib/discussion-push";
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/discussion-push", () => ({ deliverDiscussionPush: vi.fn() }));
const mocks = vi.hoisted(() => ({ save: vi.fn(), confirm: vi.fn(), read: vi.fn(), markRead: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: async () => ({ id: "synthetic-student", role: "student", mustChangePassword: false }) }));
vi.mock("@/lib/discussions", () => ({ markDiscussionMessagesRead: mocks.markRead, saveDiscussionEntry: mocks.save, confirmMeeting: mocks.confirm, assertDiscussionAccess: vi.fn(), getDiscussionData: mocks.read, seoulDate: () => "2026-09-09", DiscussionError: class extends Error {} }));
vi.mock("@/lib/discussion-summary", () => ({ summarizeDiscussionDay: vi.fn() }));
import { GET, POST } from "@/app/api/discussions/route";
const request = (data: unknown) => new Request("http://localhost/api/discussions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
it("schedules delivery only after a saved peer message and leaves failures retryable", async () => {
  vi.mocked(after).mockClear(); vi.mocked(deliverDiscussionPush).mockClear();
  const input = { action: "save", sessionId: "session", cycleId: "displayed-cycle", id: "message-id", kind: "peer", content: "합성 메시지" };
  expect((await POST(request(input))).status).toBe(200);
  expect(deliverDiscussionPush).not.toHaveBeenCalled();
  expect(after).toHaveBeenCalledOnce();
  const callback = vi.mocked(after).mock.calls[0][0] as () => Promise<void>;
  vi.mocked(deliverDiscussionPush).mockRejectedValueOnce(new Error("synthetic transient failure"));
  await expect(callback()).resolves.toBeUndefined();
  expect(deliverDiscussionPush).toHaveBeenCalledWith("message-id");
  vi.mocked(after).mockClear();
  mocks.save.mockRejectedValueOnce(new Error("synthetic save failure"));
  expect((await POST(request(input))).status).toBe(500);
  expect(after).not.toHaveBeenCalled();
});
it("bounds read batches and forwards the displayed cycle and exact message IDs", async () => {
  mocks.markRead.mockReset().mockResolvedValue({ marked: 1 });
  const input = { action: "read", sessionId: "session", cycleId: "displayed-cycle", entryIds: ["message-id"] };
  for (const invalid of [{ ...input, cycleId: undefined }, { ...input, entryIds: [] }, { ...input, entryIds: Array(101).fill("message-id") }]) expect((await POST(request(invalid))).status).toBe(400);
  expect(mocks.markRead).not.toHaveBeenCalled();
  const response = await POST(request(input));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, marked: 1 });
  expect(mocks.markRead).toHaveBeenCalledWith(expect.objectContaining({ id: "synthetic-student" }), "session", "displayed-cycle", ["message-id"]);
});
beforeEach(() => { mocks.read.mockReset().mockResolvedValue({ sources: [], history: [], jobs: [] }); mocks.save.mockReset().mockResolvedValue({ id: "message-id", date: "2026-09-09" }); mocks.confirm.mockReset().mockResolvedValue(undefined); });
it.each(["save", "confirm", "summarize"])("rejects a %s request without the displayed cycle", async action => {
  const response = await POST(request({ action, sessionId: "session", id: "message-id", kind: "peer", content: "합성 메시지", entryId: "meeting-id" }));
  expect(response.status).toBe(400); expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.confirm).not.toHaveBeenCalled();
});
it("requires an explicit cycle for reads and forwards the selected historical cycle", async () => {
  expect((await GET(new Request("http://localhost/api/discussions?sessionId=session"))).status).toBe(400);
  expect(mocks.read).not.toHaveBeenCalled();
  expect((await GET(new Request("http://localhost/api/discussions?sessionId=session&cycleId=historical-cycle"))).status).toBe(200);
  expect(mocks.read).toHaveBeenCalledWith(expect.anything(), "session", "2026-09-09", "historical-cycle");
});
it("passes the displayed cycle to both write services", async () => {
  expect((await POST(request({ action: "save", sessionId: "session", cycleId: "displayed-cycle", id: "message-id", kind: "peer", content: "합성 메시지" }))).status).toBe(200);
  expect(mocks.save).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ cycleId: "displayed-cycle" }));
  expect((await POST(request({ action: "confirm", sessionId: "session", cycleId: "displayed-cycle", entryId: "meeting-id" }))).status).toBe(200);
  expect(mocks.confirm).toHaveBeenCalledWith(expect.anything(), "session", "meeting-id", "displayed-cycle");
});
