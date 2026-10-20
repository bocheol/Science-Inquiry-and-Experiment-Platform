"use client";
import { useState } from "react";
import { RECORD_ACTIVITIES, suggestStudentFromFilename, type ActivityId, type RecordFile, type RecordStudent, type RecordWorkspace } from "@/lib/student-records/model";
import { recordsPost, type RecordsRequest } from "./workspace";

const ACCEPT = ".hwp,.hwpx,.pdf,.docx,.jpg,.jpeg,.png";
const LABELS: Record<string, string> = { pending: "본문 읽기 대기", review: "교사 확인 대기", ready: "추출 확인 완료", needs_ocr: "문자 인식 필요", error: "본문 읽기 실패" };
export async function uploadOne(request: RecordsRequest, file: File, studentId: string, activity: ActivityId) {
  const form = new FormData(); form.set("file", file); form.set("studentId", studentId); form.set("activity", activity);
  const saved = await request<{ id: string; duplicate: boolean }>("/api/records/files", { method: "POST", body: form });
  let note = saved.duplicate ? "이미 저장된 원본" : "원본 저장 완료";
  if (!saved.duplicate) {
    try { await request("/api/records/files", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: saved.id, revision: 1, action: "parse" }) }); }
    catch { note += " · 본문 읽기 재시도 필요"; }
  }
  try { await request("/api/records/files", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: saved.id, revision: 1, action: "sync" }) }); note += " · Drive 보관 완료"; }
  catch { note += " · Drive 복사 대기"; }
  return note;
}

export function RecordFileManager({ workspace, teacher, request, onChanged }: { workspace: RecordWorkspace; teacher: boolean; request: RecordsRequest; onChanged: () => Promise<void> }) {
  const [activity, setActivity] = useState<ActivityId>("individual_plan");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [docUrl, setDocUrl] = useState("");
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true); const notes: string[] = [];
    try {
      for (const file of Array.from(files)) {
        setMessage(file.name + " 저장 중…");
        try { notes.push(file.name + ": " + await uploadOne(request, file, workspace.student.id, activity)); }
        catch (error) { notes.push(file.name + ": " + (error as Error).message); }
      }
      await onChanged(); setMessage(notes.join("\n"));
    } finally { setBusy(false); }
  }
  async function importDoc() {
    setBusy(true);
    try { await request("/api/records", recordsPost("import-doc", workspace.student.id, { url: docUrl, activity })); setDocUrl(""); await onChanged(); setMessage("Google 문서 원본을 가져왔습니다. 본문 읽기를 실행해 주세요."); }
    catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="card records-section"><div className="records-section-heading"><h2>활동 원본 자료</h2><span>{workspace.files.length}개</span></div><p>HWP · HWPX · PDF · DOCX · JPG · PNG / 한 파일 10MB까지. 사진이나 스캔도 올릴 수 있습니다.</p><fieldset disabled={busy} className="records-upload"><label>자료가 속한 활동<select value={activity} onChange={e => setActivity(e.target.value as ActivityId)}>{RECORD_ACTIVITIES.map(a => <option key={a.id} value={a.id}>과탐실 {a.course} · {a.label}</option>)}</select></label><label>파일 선택<input type="file" accept={ACCEPT} multiple onChange={e => { void upload(e.target.files); e.target.value = ""; }} /></label></fieldset><p className="records-hint">기존 자료도 보존됩니다. 잘못 올린 자료는 교사에게 알려 주세요. Google Docs는 파일 → 다운로드에서 DOCX 또는 PDF로 저장해서 올릴 수 있습니다.</p>
    {teacher && <details><summary>Google Docs 주소로 가져오기</summary><p>플랫폼의 Google 연결 계정에 읽기 권한이 있는 문서만 가져옵니다.</p><div className="records-tools"><input type="url" aria-label="Google Docs 주소" value={docUrl} onChange={e => setDocUrl(e.target.value)} placeholder="https://docs.google.com/document/d/…" /><button className="button secondary" disabled={busy || !docUrl} onClick={() => void importDoc()}>가져오기</button></div></details>}
    {message && <p className="records-message" role="status">{message}</p>}
    {!workspace.files.length && <p className="records-hint">아직 첨부된 원본이 없습니다. 활동 설명만 먼저 저장할 수도 있습니다.</p>}
    {workspace.files.map(file => <RecordFileCard key={file.id + ":" + file.revision} file={file} teacher={teacher} request={request} onChanged={onChanged} />)}
  </section>;
}

function RecordFileCard({ file, teacher, request, onChanged }: { file: RecordFile; teacher: boolean; request: RecordsRequest; onChanged: () => Promise<void> }) {
  const [text, setText] = useState(file.text);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function action(kind: string) {
    setBusy(true); setMessage("");
    try { await request("/api/records/files", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: file.id, revision: file.revision, action: kind, text }) }); await onChanged(); }
    catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }
  return <details className="records-file"><summary><span>{file.name}</span><span className={file.extractionStatus === "ready" ? "badge" : "badge feedback"}>{file.included ? (LABELS[file.extractionStatus] ?? file.extractionStatus) : "활용 제외 · 학생에게 숨김"}</span><small>과탐실 {file.course} · {RECORD_ACTIVITIES.find(a => a.id === file.activity)?.label} · Drive {file.driveStatus === "saved" ? "보관 완료" : "복사 대기"}</small></summary><p>{file.extractionNote}</p><div className="records-tools"><a className="button secondary" href={"/api/records/files/" + encodeURIComponent(file.id)}>원본 내려받기</a>{file.extractionStatus !== "ready" && <button className="button secondary" disabled={busy} onClick={() => void action("parse")}>본문 읽기 재시도</button>}{teacher && file.extractionStatus !== "ready" && (file.mime.startsWith("image/") || file.mime === "application/pdf") && <button className="button secondary" disabled={busy} onClick={() => void action("ocr")}>AI 문자 인식</button>}{file.driveStatus !== "saved" && <button className="button secondary" disabled={busy} onClick={() => void action("sync")}>Drive 복사 재시도</button>}</div>
    {teacher && <p><button className="button secondary" disabled={busy} onClick={() => void action(file.included ? "exclude" : "include")}>{file.included ? "이 자료 활용 제외 · 학생에게 숨기기" : "이 자료 다시 포함"}</button></p>}{teacher ? <><label>추출 본문 확인<textarea className="textarea" value={text} onChange={e => setText(e.target.value)} disabled={busy} rows={10} maxLength={100000} placeholder="원본과 비교해 누락·오독을 수정해 주세요. 확인한 본문만 AI 근거에 사용합니다." /></label><button className="button" disabled={busy || !text.trim()} onClick={() => void action("confirm")}>{busy ? "처리 중…" : "원본과 비교했습니다 · 추출 확인"}</button></> : <pre className="records-evidence-text">{file.text || "선생님이 본문을 확인한 뒤 활용합니다."}</pre>}
    {message && <p className="records-message" role="status">{message}</p>}
  </details>;
}

type BulkRow = { file: File; studentId: string; activity: ActivityId; confirmed: boolean; message: string; done: boolean };
export function RecordBulkUpload({ students, request, onChanged }: { students: RecordStudent[]; request: RecordsRequest; onChanged: () => Promise<void> }) {
  const [rows, setRows] = useState<BulkRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  function patch(index: number, value: Partial<BulkRow>) { setRows(old => old.map((row, i) => i === index ? { ...row, ...value } : row)); }
  async function upload() {
    setBusy(true); setMessage("");
    try {
      for (const [index, row] of rows.entries()) {
        if (row.done || !row.confirmed || !row.studentId) continue;
        patch(index, { message: "원본 저장·본문 읽기 진행 중…" });
        try { patch(index, { message: await uploadOne(request, row.file, row.studentId, row.activity), done: true }); }
        catch (error) { patch(index, { message: (error as Error).message }); }
      }
      await onChanged(); setMessage("선택한 자료 처리를 마쳤습니다. 파일별 저장·추출·Drive 상태를 확인해 주세요.");
    } finally { setBusy(false); }
  }
  return <details className="card records-section"><summary className="records-summary">계획서·답안 일괄 업로드</summary><p>파일명으로 학생을 제안합니다. 학생과 활동을 확인한 파일만 저장됩니다. 같은 파일은 다시 선택해도 중복 저장하지 않습니다.</p><fieldset disabled={busy}><label>원본 파일 선택 (한 번에 최대 300개)<input type="file" accept={ACCEPT} multiple onChange={e => { const files = Array.from(e.target.files ?? []); if (files.length > 300) { setMessage("한 번에 300개까지 선택해 주세요."); return; } setRows(files.map(file => ({ file, studentId: suggestStudentFromFilename(file.name, students), activity: "individual_plan", confirmed: false, message: "", done: false }))); e.target.value = ""; }} /></label>
    {rows.length > 0 && <><div className="records-table-scroll"><table><thead><tr><th>파일</th><th>학생</th><th>활동</th><th>매칭 확인</th><th>처리 상태</th></tr></thead><tbody>{rows.map((row, index) => <tr key={index}><td>{row.file.name}</td><td><select aria-label={row.file.name + " 학생"} value={row.studentId} disabled={row.done} onChange={e => patch(index, { studentId: e.target.value, confirmed: false })}><option value="">직접 선택</option>{students.map(s => <option value={s.id} key={s.id}>{s.loginId} {s.name}</option>)}</select></td><td><select aria-label={row.file.name + " 활동"} value={row.activity} disabled={row.done} onChange={e => patch(index, { activity: e.target.value as ActivityId, confirmed: false })}>{RECORD_ACTIVITIES.map(a => <option key={a.id} value={a.id}>{a.course} · {a.label}</option>)}</select></td><td><label><input type="checkbox" checked={row.confirmed} disabled={!row.studentId || row.done} onChange={e => patch(index, { confirmed: e.target.checked })} />확인</label></td><td>{row.message || "대기"}</td></tr>)}</tbody></table></div><button className="button" disabled={!rows.some(r => r.confirmed && !r.done)} onClick={() => void upload()}>{busy ? "저장 중…" : "매칭을 확인한 파일 저장"}</button></>}
    </fieldset>{message && <p className="records-message" role="status">{message}</p>}</details>;
}
