import { beforeAll, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db";
import { GET, POST } from "@/app/api/records/route";
import { POST as upload } from "@/app/api/records/files/route";
import { GET as download } from "@/app/api/records/files/[fileId]/route";
import { uploadRecordFile } from "./files";
import type { SessionUser } from "@/lib/types";

const auth = vi.hoisted(() => ({ user: null as SessionUser | null }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: async () => auth.user }));
const owner: SessionUser = { id: "demo_student_1", name: "합성 학생", loginId: "10901", role: "student", academicYear: 2026, classId: "class_2026_9", classNumber: 9, mustChangePassword: false };
beforeAll(async () => { const db = await getDb(); await db.query("INSERT INTO record_teacher_classes (class_id,teacher_id) VALUES ('class_2026_9','teacher_bootstrap')"); });
describe("record route security", () => {
  it("denies unauthenticated requests and the previous user's pending request after a login switch", async () => {
    auth.user = null;
    expect((await GET(new Request("https://local.invalid/api/records"))).status).toBe(403);
    auth.user = { ...owner, id: "demo_student_2", loginId: "10902" };
    expect((await POST(new Request("https://local.invalid/api/records", { method: "POST", headers: { "x-records-user": owner.id, "content-type": "application/json" }, body: JSON.stringify({ action: "submission", data: {} }) }))).status).toBe(403);
  });
  it("denies another student's workspace, history and teacher-only mutations", async () => {
    auth.user = owner;
    const headers = { "x-records-user": owner.id, "content-type": "application/json" };
    expect((await GET(new Request("https://local.invalid/api/records?studentId=demo_student_2", { headers }))).status).toBe(403);
    expect((await GET(new Request("https://local.invalid/api/records?history=1", { headers }))).status).toBe(403);
    expect((await POST(new Request("https://local.invalid/api/records", { method: "POST", headers, body: JSON.stringify({ action: "settings", data: { expectedRevision: 0, style: "unauthorized", opensAt: null, deadlineAt: null } }) }))).status).toBe(403);
  });
  it("bounds upload bodies before parsing and verifies direct-download ownership", async () => {
    auth.user = owner;
    const rejected = await upload(new Request("https://local.invalid/api/records/files", { method: "POST", headers: { "x-records-user": owner.id, "content-length": "999999999" }, body: "oversized" }));
    expect(rejected.status).toBe(413);
    const file = await uploadRecordFile(owner, owner.id, "exam", "original.pdf", Buffer.from("%PDF-1.7\nsynthetic"));
    auth.user = { ...owner, id: "demo_student_2", loginId: "10902" };
    expect((await download(new Request("https://local.invalid/api/records/files/" + file.id), { params: Promise.resolve({ fileId: file.id }) })).status).toBe(403);
    auth.user = owner;
    const allowed = await download(new Request("https://local.invalid/api/records/files/" + file.id), { params: Promise.resolve({ fileId: file.id }) });
    expect(allowed.status).toBe(200); expect(allowed.headers.get("content-disposition")).toContain("attachment"); expect(allowed.headers.get("cache-control")).toContain("no-store");
  });
});
