import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/journal-service", () => ({
  JOURNAL_MAX_IMAGES: 5, JOURNAL_MAX_IMAGE_BYTES: 5 * 1024 * 1024,
  JournalAccessError: class extends Error {},
  detectJournalImageType: () => "image/png",
  listStudentJournals: vi.fn(), saveStudentJournal: mocks.save,
}));
import { POST } from "@/app/api/inquiry/journals/route";

beforeEach(() => {
  mocks.user.mockResolvedValue({ id: "synthetic-uploader", role: "student", mustChangePassword: false });
  mocks.save.mockReset().mockResolvedValue({ id: "synthetic-journal" });
});

function streamedRequest(length?: string) {
  const cancel = vi.fn();
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024 * 1024)); },
    cancel,
  }, { highWaterMark: 0 });
  const headers = new Headers({ "content-type": "multipart/form-data; boundary=synthetic-budget" });
  if (length !== undefined) headers.set("content-length", length);
  const request = new Request("http://localhost/api/inquiry/journals", {
    method: "POST", headers, body: stream, duplex: "half",
  } as RequestInit);
  return { request, cancel, pulls: () => pulls };
}

it.each([undefined, "1"])("cancels an oversized multipart stream with content length %s before saving", async length => {
  const input = streamedRequest(length);
  const response = await POST(input.request);
  expect(response.status).toBe(413);
  expect(input.cancel).toHaveBeenCalledOnce();
  expect(input.pulls()).toBe(27);
  expect(mocks.save).not.toHaveBeenCalled();
});

it("rejects declared oversize without consuming the body", async () => {
  const input = streamedRequest(String(27 * 1024 * 1024));
  expect((await POST(input.request)).status).toBe(413);
  expect(input.pulls()).toBe(0);
  expect(input.cancel).toHaveBeenCalledOnce();
  expect(mocks.save).not.toHaveBeenCalled();
});

it("keeps authentication ahead of body consumption", async () => {
  mocks.user.mockResolvedValueOnce(null);
  const input = streamedRequest();
  expect((await POST(input.request)).status).toBe(403);
  expect(input.pulls()).toBe(0);
  expect(mocks.save).not.toHaveBeenCalled();
  await input.request.body?.cancel();
});

it("rejects malformed multipart without storing a journal", async () => {
  const request = new Request("http://localhost/api/inquiry/journals", {
    method: "POST", headers: { "content-type": "multipart/form-data; boundary=missing" }, body: "invalid",
  });
  expect((await POST(request)).status).toBe(400);
  expect(mocks.save).not.toHaveBeenCalled();
});

it("accepts five maximum-size photos and maximum Korean text", async () => {
  const data = new FormData();
  for (const [key, value] of Object.entries({ sessionId: "synthetic-session", cycleId: "synthetic-cycle", sessionNumber: "1", date: "2026-09-09", expectedVersion: "null", existingImageIds: "[]" })) data.set(key, value);
  for (const key of ["activities", "observations", "reflections"]) data.set(key, "가".repeat(10_000));
  const photoIds = Array.from({ length: 5 }, (_, i) => `synthetic-photo-${i}`);
  data.set("photoClientIds", JSON.stringify(photoIds));
  for (const id of photoIds) data.append("photos", new Blob([new Uint8Array(5 * 1024 * 1024)], { type: "image/png" }), `${id}.png`);
  expect((await POST(new Request("http://localhost/api/inquiry/journals", { method: "POST", body: data }))).status).toBe(200);
  expect(mocks.save).toHaveBeenCalledOnce();
  expect(mocks.save.mock.calls[0][1].photos).toHaveLength(5);
});
