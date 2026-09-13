import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), access: vi.fn(), cycle: vi.fn(), create: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/db", () => ({ audit: mocks.audit }));
vi.mock("@/lib/discussions", () => ({
  DiscussionError: class extends Error { constructor(message: string, public status = 400) { super(message); } },
  assertDiscussionAccess: mocks.access,
  discussionCycle: mocks.cycle,
}));
vi.mock("@/lib/ai", () => ({
  getOpenAIClient: () => ({ audio: { transcriptions: { create: mocks.create } } }),
  userFacingAiError: () => "AI 연결을 확인해 주세요.",
}));
import { POST } from "@/app/api/discussions/transcribe/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user.mockResolvedValue({ id: "student", role: "student", mustChangePassword: false });
  mocks.access.mockResolvedValue("team");
  mocks.cycle.mockResolvedValue({ id: "cycle", status: "active" });
  mocks.create.mockResolvedValue({ text: "온도를 3분마다 측정했다." });
});

function request(type = "audio/webm") {
  const data = new FormData();
  data.set("sessionId", "session"); data.set("cycleId", "cycle");
  data.set("audio", new Blob(["synthetic audio"], { type }), "meeting.webm");
  return new Request("http://localhost/api/discussions/transcribe", { method: "POST", body: data });
}

it("authenticates before consuming an audio body", async () => {
  mocks.user.mockResolvedValueOnce(null);
  const response = await POST(request());
  expect(response.status).toBe(403);
  expect(mocks.access).not.toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
});

it("checks current team and cycle before transcribing Korean audio", async () => {
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ text: "온도를 3분마다 측정했다." });
  expect(mocks.access).toHaveBeenCalledWith(expect.objectContaining({ id: "student" }), "session", true);
  expect(mocks.cycle).toHaveBeenCalledWith("session", "cycle");
  expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-transcribe", language: "ko" }));
  expect(mocks.audit).toHaveBeenCalledWith("student", "meeting_audio_transcribed", "inquiry_cycle", "cycle", expect.objectContaining({ model: "gpt-transcribe" }));
});

it("rejects non-audio uploads without calling the model", async () => {
  expect((await POST(request("text/plain"))).status).toBe(400);
  expect(mocks.create).not.toHaveBeenCalled();
});

it("accepts browser codec parameters on a supported audio type", async () => {
  expect((await POST(request("audio/webm;codecs=opus"))).status).toBe(200);
  expect(mocks.create).toHaveBeenCalledOnce();
});

it("does not transcribe a completed cycle", async () => {
  mocks.cycle.mockResolvedValueOnce({ id: "cycle", status: "completed" });
  expect((await POST(request())).status).toBe(409);
  expect(mocks.create).not.toHaveBeenCalled();
});
