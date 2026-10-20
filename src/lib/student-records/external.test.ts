import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db";
import { collectRecordEvidence } from "./evidence";
import { generateRecordDraft } from "./ai";
import { exportTeacherRecords, syncRecordFileToDrive } from "./google";
import { getRecordFile, uploadRecordFile } from "./files";
import { getRecordWorkspace, saveRecordDraft, saveRecordSubmission } from "./service";
import type { RecordActor } from "./access";

const provider = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock("@/lib/ai", () => ({ getOpenAIClient: () => ({ responses: { parse: provider.parse } }), safetyIdentifier: () => "synthetic-student", userFacingAiError: () => "합성 생성 오류" }));
vi.mock("google-auth-library", () => ({
  GoogleAuth: class { async getClient() { return { getRequestHeaders: async () => new Headers({ authorization: "Bearer synthetic-only" }) }; } },
  OAuth2Client: class { setCredentials() {} async getRequestHeaders() { return new Headers({ authorization: "Bearer synthetic-only" }); } },
}));
const teacher: RecordActor = { id: "teacher_bootstrap", role: "teacher", mustChangePassword: false };
const student: RecordActor = { id: "demo_student_1", role: "student", mustChangePassword: false };
beforeAll(async () => {
  const db = await getDb();
  await db.query("INSERT INTO record_teacher_classes (class_id,teacher_id) VALUES ('class_2026_9',$1)", [teacher.id]);
  await db.query("INSERT INTO record_teacher_settings (teacher_id,spreadsheet_id,folder_id) VALUES ($1,'synthetic-teacher-sheet','synthetic-folder')", [teacher.id]);
  await saveRecordSubmission(student, student.id, { expectedRevision: 0, selected: ["egg", "spectrum"], comments: { egg: "COURSE_ONE_PRIVATE", spectrum: "관찰 설명" }, submit: true });
  await db.query("UPDATE investigation_plans SET form_data = $1 WHERE id = 'demo_plan_1'", [JSON.stringify({ topic: "COURSE_TWO_PRIVATE" })]);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); provider.parse.mockReset(); });

describe("external service boundaries with synthetic transports", () => {
  it("sends independent course inputs and reuses the identical paid result", async () => {
    provider.parse.mockImplementation(async (request: { input: string }) => {
      const payload = JSON.parse(request.input) as { evidence: { id: string }[] };
      return { model: "synthetic", output: [], output_parsed: { sentences: [{ text: "제공된 활동 근거를 검토함.", evidenceIds: [payload.evidence[0].id] }], warnings: [] } };
    });
    const evidence = await collectRecordEvidence(await getDb(), teacher, student.id);
    const first = await generateRecordDraft(teacher, student.id, evidence.hash);
    expect(provider.parse).toHaveBeenCalledTimes(2);
    const one = provider.parse.mock.calls[0][0].input as string, two = provider.parse.mock.calls[1][0].input as string;
    expect(one).toContain("COURSE_ONE_PRIVATE"); expect(one).not.toContain("COURSE_TWO_PRIVATE");
    expect(two).toContain("COURSE_TWO_PRIVATE"); expect(two).not.toContain("COURSE_ONE_PRIVATE");
    expect(provider.parse.mock.calls.every(([request]) => request.store === false)).toBe(true);
    expect((await generateRecordDraft(teacher, student.id, evidence.hash)).result).toEqual(first.result);
    expect(provider.parse).toHaveBeenCalledTimes(2);
    await expect(generateRecordDraft(student, student.id, evidence.hash)).rejects.toMatchObject({ status: 403 });
    expect((await getRecordWorkspace(teacher, student.id)).draft!.course1).toBe("");
  });
  it("uses a reserved Drive ID to recover a lost upload response without a duplicate file", async () => {
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_JSON", "{}");
    const file = await uploadRecordFile(teacher, student.id, "exam", "synthetic.pdf", Buffer.from("%PDF-1.7\nsynthetic"));
    let uploaded = false, postCount = 0;
    const transport = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("generateIds")) return Response.json({ ids: ["reserved-synthetic-id"] });
      if (url.includes("/upload/")) { postCount++; uploaded = true; throw new TypeError("lost response"); }
      if (!uploaded) return new Response("{}", { status: 404 });
      const stored = await getRecordFile(teacher, file.id);
      expect(init?.method ?? "GET").toBe("GET");
      return Response.json({ id: "reserved-synthetic-id", appProperties: { recordFileId: file.id, sha256: stored.content_hash } });
    });
    vi.stubGlobal("fetch", transport);
    await expect(syncRecordFileToDrive(teacher, file.id)).rejects.toThrow();
    expect((await getRecordFile(teacher, file.id)).drive_status).toBe("error");
    expect(await syncRecordFileToDrive(teacher, file.id)).toEqual({ saved: true });
    expect(postCount).toBe(1); expect((await getRecordFile(teacher, file.id)).drive_status).toBe("saved");
  });
  it("exports only assigned finalized students to a new tab with RAW text and leaves manual tabs alone", async () => {
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_JSON", "{}");
    const workspace = await getRecordWorkspace(teacher, student.id);
    await saveRecordDraft(teacher, student.id, { expectedRevision: 0, expectedSubmissionRevision: workspace.submission.revision, expectedEvidenceHash: workspace.evidence!.hash, course1: "=1+1", course2: "학생의 탐구 자료를 확인함.", notes: "없는 자료 확인 완료", checkedGroups: ["team_plan", "journal", "team_report", "exam"], finalize: true });
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes(":batchUpdate")) return Response.json({ replies: [{ addSheet: { properties: { sheetId: 77 } } }] });
      if (url.includes("/values/")) return Response.json({ updatedRows: 2 });
      return Response.json({ sheets: [{ properties: { title: "9반", sheetId: 1 } }] });
    }));
    const exported = await exportTeacherRecords(teacher, "synthetic-export-request-1");
    expect(exported.count).toBe(1); expect(exported.url).toContain("synthetic-teacher-sheet");
    const writes = calls.filter(c => c.init?.method === "PUT"); expect(writes).toHaveLength(1);
    expect(writes[0].url).toContain("valueInputOption=RAW");
    expect(decodeURIComponent(writes[0].url)).toContain("플랫폼확정_"); expect(decodeURIComponent(writes[0].url)).not.toContain("'9반'");
    const values = JSON.parse(writes[0].init!.body as string).values;
    expect(values).toHaveLength(2); expect(values[1][4]).toBe("=1+1");
  });
  it("refuses exporting stale final evidence before making any remote call", async () => {
    const transport = vi.fn(); vi.stubGlobal("fetch", transport);
    await (await getDb()).query("UPDATE investigation_plans SET form_data = $1 WHERE id = 'demo_plan_1'", [JSON.stringify({ topic: "changed after finalization" })]);
    await expect(exportTeacherRecords(teacher, "synthetic-export-request-2")).rejects.toMatchObject({ status: 409 });
    expect(transport).not.toHaveBeenCalled();
  });
});
