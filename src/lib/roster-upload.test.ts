import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), import: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/roster", () => ({ importRoster: mocks.import }));
vi.mock("@/lib/teacher-data", () => ({ getTeacherDashboardData: vi.fn() }));
import { POST } from "@/app/api/teacher/roster/route";
import { ROSTER_MAX_BYTES, RosterInputError } from "@/lib/roster-parser";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue({ id: "synthetic", role: "teacher", mustChangePassword: false });
  mocks.import.mockResolvedValue({ total: 1, issued: [] });
});
async function upload(size = 1) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(size)], "명단.xlsx"));
  const encoded = new Request("http://localhost/api/teacher/roster", { method: "POST", body: form });
  // The server receives encoded network bytes, not Undici's outgoing FormData producer.
  return new Request(encoded.url, { method: "POST", headers: encoded.headers, body: await encoded.arrayBuffer() });
}
it("passes a bounded multipart file to the importer", async () => {
  expect((await POST(await upload())).status).toBe(200);
  expect(mocks.import).toHaveBeenCalledOnce();
});
it.each([ROSTER_MAX_BYTES + 1, ROSTER_MAX_BYTES + 128 * 1024])("rejects %s byte files without Content-Length before import", async size => {
  const request = await upload(size);
  expect(request.headers.has("content-length")).toBe(false);
  expect((await POST(request)).status).toBe(413);
  expect(mocks.import).not.toHaveBeenCalled();
});
it("uses actual bytes even when Content-Length is false and cancels the stream", async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(ROSTER_MAX_BYTES + 128 * 1024)); }, cancel });
  const request = new Request("http://localhost/api/teacher/roster", { method: "POST", headers: { "content-length": "1" }, body: stream, duplex: "half" } as RequestInit);
  expect((await POST(request)).status).toBe(413);
  expect(cancel).toHaveBeenCalledOnce();
  expect(mocks.import).not.toHaveBeenCalled();
});
it("keeps actionable validation but hides unexpected internal errors", async () => {
  mocks.import.mockRejectedValueOnce(new RosterInputError("2행 반은 1~9여야 합니다."));
  expect(await (await POST(await upload())).json()).toEqual({ message: "2행 반은 1~9여야 합니다." });
  mocks.import.mockRejectedValueOnce(new Error("synthetic-secret C:/private/path"));
  expect(await (await POST(await upload())).json()).toEqual({ message: "명단을 가져오지 못했습니다. 잠시 후 다시 시도해 주세요." });
});
