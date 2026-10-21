import { GoogleAuth, OAuth2Client } from "google-auth-library";
import { createHash } from "node:crypto";
import { getDb } from "@/lib/db";
import { assertRecordActor, assertRecordStudent, withRecordTransmissionAccess, RecordError, recordSettings, recordTransaction, teacherRecordStudents, type RecordActor } from "./access";
import { getRecordFile, uploadRecordFile } from "./files";
import { getRecordWorkspace } from "./service";
import { combinedRecordBytes, recordBytes, RECORD_ACTIVITIES } from "./model";
import { RECORD_FILE_MAX_BYTES } from "./extraction";

export function recordsGoogleConfigured() {
  return Boolean((process.env.RECORDS_GOOGLE_CLIENT_ID && process.env.RECORDS_GOOGLE_CLIENT_SECRET && process.env.RECORDS_GOOGLE_REFRESH_TOKEN) || process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.K_SERVICE);
}

async function authHeaders() {
  if (!recordsGoogleConfigured()) throw new RecordError("Google 저장소 연결 대기 중입니다. 원본은 플랫폼에 보관되어 있습니다.", 503);
  if (process.env.RECORDS_GOOGLE_REFRESH_TOKEN) {
    const auth = new OAuth2Client(process.env.RECORDS_GOOGLE_CLIENT_ID, process.env.RECORDS_GOOGLE_CLIENT_SECRET);
    auth.setCredentials({ refresh_token: process.env.RECORDS_GOOGLE_REFRESH_TOKEN });
    return Object.fromEntries((await auth.getRequestHeaders()).entries());
  }
  let credentials: Record<string, string> | undefined;
  try { credentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) as Record<string, string> : undefined; }
  catch { throw new RecordError("Google 저장소 연결 설정을 확인해 주세요.", 503); }
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/drive.file", "https://www.googleapis.com/auth/spreadsheets"], ...(credentials ? { credentials } : {}) });
  return Object.fromEntries((await (await auth.getClient()).getRequestHeaders()).entries());
}

type TransmissionScope = { actor: RecordActor; items: { studentId: string; evidence?: unknown }[] };
export async function recordsGoogleRequest(url: string, init: RequestInit = {}, scope?: TransmissionScope) {
  // This helper is deliberately not exposed to user-supplied URLs.
  if (!/^https:\/\/(www\.googleapis\.com|sheets\.googleapis\.com)\//.test(url)) throw new RecordError("지원하지 않는 Google 주소입니다.");
  // Token refresh may take arbitrarily long. Do it before acquiring locks,
  // then validate all recipients and dispatch with the grants still locked.
  const headers = { ...(await authHeaders()), ...Object.fromEntries(new Headers(init.headers).entries()) };
  const send = async () => {
    const response = await fetch(url, { ...init, redirect: "error", headers, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      if (response.status === 404) throw new RecordError("Google 파일을 찾을 수 없거나 연결 계정에 접근 권한이 없습니다.", 404);
      throw new RecordError("Google 저장에 실패했습니다. 연결 계정의 파일 권한과 저장 공간을 확인한 뒤 재시도해 주세요. 플랫폼 원본은 보관되어 있습니다.", 503);
    }
    return response;
  };
  return scope ? withRecordTransmissionAccess(scope.actor, scope.items, send) : send();
}

export async function syncRecordFileToDrive(actor: RecordActor, id: string) {
  const file = await getRecordFile(actor, id);
  const db = await getDb();
  const student = await assertRecordStudent(db, actor, file.student_id);
  const settings = await recordSettings(db, student.teacher_id);
  if (!settings.folderId) throw new RecordError("세특 원본을 보관할 Drive 폴더를 먼저 연결해 주세요.", 503);
  if (file.drive_status === "saved" && file.drive_file_id) return { saved: true };
  let driveId = file.drive_file_id;
  if (!driveId) {
    const generated = await (await recordsGoogleRequest("https://www.googleapis.com/drive/v3/files/generateIds?count=1&space=drive&type=files")).json() as { ids: string[] };
    driveId = await recordTransaction(actor, file.student_id, async client => {
      const current = (await client.query<{ drive_file_id: string | null }>("SELECT drive_file_id FROM record_files WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (current.drive_file_id) return current.drive_file_id;
      if (!generated.ids?.[0]) throw new RecordError("Drive 저장 식별자를 준비하지 못했습니다.");
      await client.query("UPDATE record_files SET drive_file_id = $2 WHERE id = $1", [id, generated.ids[0]]);
      return generated.ids[0];
    });
  }
  try {
    // Reserved IDs make uncertain network retries idempotent.
    let exists = false;
    try {
      const current = await (await recordsGoogleRequest("https://www.googleapis.com/drive/v3/files/" + driveId + "?fields=id,appProperties&supportsAllDrives=true")).json() as { appProperties?: { recordFileId?: string; sha256?: string } };
      if (current.appProperties?.recordFileId !== id || current.appProperties.sha256 !== file.content_hash) throw new RecordError("Drive 원본 식별자가 다릅니다. 연결을 확인해 주세요.", 409);
      exists = true;
    } catch (error) { if (!(error instanceof RecordError) || error.status !== 404) throw error; }
    if (!exists) {
      await assertRecordStudent(db, actor, file.student_id);
      const boundary = "records_" + createHash("sha256").update(id).digest("hex");
      const metadata = { id: driveId, name: student.login_id + "_" + file.file_name, parents: [settings.folderId], appProperties: { recordFileId: id, sha256: file.content_hash } };
      const body = Buffer.concat([Buffer.from("--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify(metadata) + "\r\n--" + boundary + "\r\nContent-Type: " + file.mime_type + "\r\n\r\n"), Buffer.from(file.file_data), Buffer.from("\r\n--" + boundary + "--")]);
      await recordsGoogleRequest("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id", { method: "POST", headers: { "Content-Type": "multipart/related; boundary=" + boundary }, body }, { actor, items: [{ studentId: file.student_id }] });
    }
    await recordTransaction(actor, file.student_id, async client => { await client.query("UPDATE record_files SET drive_status = 'saved' WHERE id = $1", [id]); });
    return { saved: true };
  } catch (error) {
    await db.query("UPDATE record_files SET drive_status = 'error' WHERE id = $1", [id]);
    throw error;
  }
}

export async function importRecordGoogleDoc(actor: RecordActor, studentId: string, activity: string, url: string) {
  await assertRecordActor(await getDb(), actor, true);
  await assertRecordStudent(await getDb(), actor, studentId);
  const match = /^https:\/\/docs\.google\.com\/document\/d\/([A-Za-z0-9_-]+)(?:\/[^\s]*)?$/.exec(url.trim());
  if (!match) throw new RecordError("Google Docs 문서 주소를 입력해 주세요.");
  const mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const response = await recordsGoogleRequest("https://www.googleapis.com/drive/v3/files/" + match[1] + "/export?mimeType=" + encodeURIComponent(mime));
  const reader = response.body?.getReader();
  if (!reader) throw new RecordError("문서를 내려받지 못했습니다.");
  const parts: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > RECORD_FILE_MAX_BYTES) { await reader.cancel(); throw new RecordError("Google 문서 내보내기가 10MB를 넘습니다.", 413); } parts.push(part.value); }
  } finally { reader.releaseLock(); }
  return uploadRecordFile(actor, studentId, activity, "GoogleDocs_" + match[1] + ".docx", Buffer.concat(parts));
}

export async function exportTeacherRecords(actor: RecordActor, requestId: string) {
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(requestId)) throw new RecordError("내보내기 요청을 다시 시작해 주세요.");
  const students = await teacherRecordStudents(actor);
  const settings = await recordSettings(await getDb(), actor.id);
  if (!settings.spreadsheetId) throw new RecordError("이 교사의 별도 스프레드시트를 먼저 연결해 주세요.");
  const values: (string | number)[][] = [["학번", "이름", "반", "과탐실 1 선택 활동", "과탐실 1 세특", "1 바이트", "과탐실 2 세특", "2 바이트", "합계", "상태", "검토 버전"]];
  const exportEvidence: { studentId: string; evidence: unknown }[] = [];
  for (const student of students) {
    const workspace = await getRecordWorkspace(actor, student.id);
    const draft = workspace.draft!;
    if (draft.status !== "final") continue;
    if (draft.sourceRevision !== workspace.submission.revision || draft.evidence?.hash !== workspace.evidence?.hash) throw new RecordError(student.loginId + " 학생의 확정 후 자료가 변경되었습니다. 다시 검토하고 확정해 주세요.", 409);
    exportEvidence.push({ studentId: student.id, evidence: draft.evidence });
    values.push([student.loginId, student.name, student.classNumber, workspace.submission.selected.map(id => RECORD_ACTIVITIES.find(a => a.id === id)!.label).join(" / "), draft.course1, recordBytes(draft.course1), draft.course2, recordBytes(draft.course2), combinedRecordBytes(draft.course1, draft.course2), "교사 확정", draft.revision]);
  }
  if (values.length === 1) throw new RecordError("내보낼 교사 확정본이 없습니다.");
  const root = "https://sheets.googleapis.com/v4/spreadsheets/" + settings.spreadsheetId;
  const suffix = createHash("sha256").update(actor.id + requestId).digest("hex").slice(0, 10);
  const title = "플랫폼확정_" + suffix;
  const metadata = await (await recordsGoogleRequest(root + "?fields=sheets.properties(sheetId,title)")).json() as { sheets: { properties: { sheetId: number; title: string } }[] };
  let sheetId = metadata.sheets.find(s => s.properties.title === title)?.properties.sheetId;
  if (sheetId !== undefined) {
    const previous = await (await recordsGoogleRequest(root + "/values/" + encodeURIComponent("'" + title + "'!A:K") + "?valueRenderOption=UNFORMATTED_VALUE")).json() as { values?: unknown[][] };
    if (previous.values?.length) {
      const comparable = (rows: unknown[][]) => rows.map(row => Array.from({ length: 11 }, (_, i) => String(row[i] ?? "")));
      if (JSON.stringify(comparable(previous.values)) !== JSON.stringify(comparable(values))) throw new RecordError("이 내보내기 탭에 이미 다른 내용이 있습니다. 기존 내용을 보존했습니다. 새 내보내기로 저장해 주세요.", 409);
      return withRecordTransmissionAccess(actor, exportEvidence, async () => ({ url: "https://docs.google.com/spreadsheets/d/" + settings.spreadsheetId + "/edit#gid=" + sheetId, count: values.length - 1 }));
    }
  }
  await assertRecordActor(await getDb(), actor, true);
  // Add a separate tab. Never overwrite the teacher's hand-edited class tabs.
  if (sheetId === undefined) {
    const result = await (await recordsGoogleRequest(root + ":batchUpdate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requests: [{ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1, frozenColumnCount: 2 } } } }] }) }, { actor, items: exportEvidence })).json() as { replies: { addSheet: { properties: { sheetId: number } } }[] };
    sheetId = result.replies[0].addSheet.properties.sheetId;
  }
  const range = "'" + title + "'!A1:K" + values.length;
  // The request helper prepares auth, then locks and checks the whole batch.
  await recordsGoogleRequest(root + "/values/" + encodeURIComponent(range) + "?valueInputOption=RAW", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ range, values }) }, { actor, items: exportEvidence });
  return { url: "https://docs.google.com/spreadsheets/d/" + settings.spreadsheetId + "/edit#gid=" + sheetId, count: values.length - 1 };
}
