import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), context: vi.fn(), create: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/db", () => ({ audit: mocks.audit }));
vi.mock("@/lib/live-ai", () => ({ buildLiveAiSessionContext: mocks.context }));
vi.mock("@/lib/ai", () => ({
  getOpenAIClient: () => ({ realtime: { clientSecrets: { create: mocks.create } } }),
  safetyIdentifier: () => "hashed-team",
  userFacingAiError: () => "AI 연결을 확인해 주세요.",
}));
import { POST } from "@/app/api/inquiry/live-ai/session/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user.mockResolvedValue({ id: "student", role: "student", mustChangePassword: false });
  mocks.context.mockResolvedValue({ teamId: "team", instructions: "public team context only" });
  mocks.create.mockResolvedValue({ value: "ephemeral-secret", expires_at: 12345 });
});

const request = () => new Request("http://localhost/api/inquiry/live-ai/session", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "session", cycleId: "cycle" }),
});

it("issues a short-lived browser secret with non-interrupting semantic VAD", async () => {
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ clientSecret: "ephemeral-secret", expiresAt: 12345 });
  expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
    expires_after: { anchor: "created_at", seconds: 60 },
    session: expect.objectContaining({
      model: "gpt-realtime-2.1-mini",
      max_output_tokens: 180,
      audio: expect.objectContaining({ input: expect.objectContaining({
        transcription: expect.objectContaining({ model: "gpt-transcribe", language: "ko" }),
        turn_detection: { type: "semantic_vad", eagerness: "low", create_response: true, interrupt_response: false },
      }) }),
    }),
  }), expect.objectContaining({ headers: { "OpenAI-Safety-Identifier": "hashed-team" } }));
});

it("does not create a secret for an unauthenticated request", async () => {
  mocks.user.mockResolvedValueOnce(null);
  expect((await POST(request())).status).toBe(403);
  expect(mocks.context).not.toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
});
