import { beforeEach, expect, it, vi } from "vitest";
import { FormWriteConflict } from "@/lib/form-write-conflict";

const mocks = vi.hoisted(() => ({ save: vi.fn(), list: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn(async () => ({
  id: "journal_api_student", name: "합성 학생", loginId: "journal-api", role: "student",
  academicYear: 2026, classId: "class_2026_1", classNumber: 1, mustChangePassword: false,
})) }));
vi.mock("@/lib/journal-service", () => ({
  JOURNAL_MAX_IMAGES: 5, JOURNAL_MAX_IMAGE_BYTES: 5 * 1024 * 1024,
  JournalAccessError: class JournalAccessError extends Error { status = 400; },
  detectJournalImageType: vi.fn(), listStudentJournals: mocks.list, saveStudentJournal: mocks.save,
}));
import { POST } from "@/app/api/inquiry/journals/route";

function request(expectedVersion?: string) {
  const data = new FormData();
  data.set("cycleId", "journal_api_cycle"); data.set("sessionId", "journal_api_session"); data.set("sessionNumber", "1"); data.set("date", "2026-09-07");
  data.set("activities", "합성 활동"); data.set("observations", "합성 관찰"); data.set("reflections", "");
  data.set("existingImageIds", "[]"); data.set("photoClientIds", "[]");
  if (expectedVersion !== undefined) data.set("expectedVersion", expectedVersion);
  return new Request("http://localhost/api/inquiry/journals", { method: "POST", body: data });
}

beforeEach(() => { mocks.save.mockReset(); mocks.list.mockReset(); });

it("requires an explicit null or numeric journal base version", async () => {
  expect((await POST(request())).status).toBe(400);
  expect((await POST(request("unknown"))).status).toBe(400);
  expect(mocks.save).not.toHaveBeenCalled();
});

it("returns 409 for a journal write conflict", async () => {
  mocks.save.mockRejectedValueOnce(new FormWriteConflict());
  const response = await POST(request("0"));
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ message: expect.stringContaining("최신") });
});

it("does not expose unexpected journal storage details", async () => {
  mocks.save.mockRejectedValueOnce(new Error("postgresql://internal:secret@private/journals"));
  const response = await POST(request("0"));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ message: "실험 일지를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요." });
});

it("passes a nullable base and returns the confirmed saved version", async () => {
  mocks.save.mockResolvedValueOnce({ id: "journal", version: 1 });
  const response = await POST(request("null"));
  expect(response.status).toBe(200);
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ id: "journal_api_student" }), expect.objectContaining({ expectedVersion: null }));
  expect(await response.json()).toMatchObject({ journal: { version: 1 } });
});
