"use client";
import { useEffect, useState } from "react";
import { ACTIVITY_CHAR_LIMIT, combinedRecordBytes, COURSE_TWO_GROUPS, RECORD_ACTIVITIES, recordBytes, type ActivityId, type RecordAiResult, type RecordSettings, type RecordWorkspace } from "@/lib/student-records/model";
import { RecordFileManager } from "./files";
import { recordsPost, type RecordsRequest } from "./workspace";

type FormProps = { workspace: RecordWorkspace; request: RecordsRequest; onChanged: () => Promise<void>; onDirty: (value: boolean) => void };
const localTime = (iso: string | null) => iso ? new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 16) : "";
const fromSeoul = (value: string) => value ? new Date(value + "+09:00").toISOString() : null;
const shownTime = (value: string | null) => value ? new Date(value).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "미설정";

export function StudentRecordForm({ workspace, request, onChanged, onDirty }: FormProps) {
  const [selected, setSelected] = useState(workspace.submission.selected);
  const [comments, setComments] = useState(workspace.submission.comments);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [latest, setLatest] = useState<RecordWorkspace | null>(null);
  function choose(id: ActivityId) {
    if (!selected.includes(id) && selected.length >= 3) { setMessage("과탐실 1 활동은 3개까지 선택할 수 있습니다."); return; }
    setSelected(old => old.includes(id) ? old.filter(a => a !== id) : [...old, id]); onDirty(true);
  }
  async function save(submit: boolean) {
    setBusy(true); setMessage("");
    try {
      await request("/api/records", recordsPost("submission", workspace.student.id, { expectedRevision: workspace.submission.revision, selected, comments, submit }));
      onDirty(false); await onChanged(); setMessage(submit ? "선생님께 제출했습니다. 기한 전에는 수정하여 다시 제출할 수 있습니다." : "활동 선택과 설명을 저장했습니다.");
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }
  const comment = (id: ActivityId) => <label className="records-comment">나의 활동 설명 <span>선택 입력 · {Array.from(comments[id] ?? "").length}/{ACTIVITY_CHAR_LIMIT}자</span><textarea className="textarea" rows={3} disabled={busy} value={comments[id] ?? ""} placeholder="내가 한 일, 생각한 점, 더 탐구한 내용을 적어 주세요. 비워 두어도 됩니다." onChange={e => { const value = e.target.value; if (Array.from(value).length <= ACTIVITY_CHAR_LIMIT) { setComments(old => ({ ...old, [id]: value })); onDirty(true); } }} /></label>;
  return <>
    <section className="card records-section"><div className="records-section-heading"><h2>{workspace.student.name}의 활동 모음</h2><span className="badge">{workspace.submission.status === "submitted" ? "제출 완료" : workspace.submission.status === "returned" ? "수정 요청" : "작성 중"}</span></div><p>접수 시작 {shownTime(workspace.settings.opensAt)} · 마감 {shownTime(workspace.settings.deadlineAt)}</p>{workspace.submission.returnedNote && <p className="records-message">선생님의 요청: {workspace.submission.returnedNote}<br />수정 가능 기한: {shownTime(workspace.submission.reopenedUntil)}</p>}</section>
    <section className="card records-section"><div className="records-section-heading"><h2><span className="records-course-number">1</span> 과탐실 1 활동 선택</h2><span>{selected.length}/3 선택</span></div><p>세특에 활용하고 싶은 활동을 2~3개 골라 주세요.</p><div className="records-activity-grid">{RECORD_ACTIVITIES.filter(a => a.course === 1).map(a => <div className={"records-activity " + (selected.includes(a.id) ? "selected" : "")} key={a.id}><label className="records-choice"><input type="checkbox" checked={selected.includes(a.id)} disabled={busy} onChange={() => choose(a.id)} />{a.label}</label>{selected.includes(a.id) && comment(a.id)}</div>)}</div></section>
    <section className="card records-section"><h2><span className="records-course-number">2</span> 과탐실 2 활동 모음</h2><p>플랫폼의 팀 계획서·본인 일지·팀 보고서와 나의 역할·개별 시험을 선생님이 함께 확인합니다. 덧붙일 내용이 있으면 적어 주세요.</p><div className="records-activity-grid">{RECORD_ACTIVITIES.filter(a => a.course === 2).map(a => <div className="records-activity" key={a.id}><h3>{a.label}</h3>{comment(a.id)}</div>)}</div></section>
    <div className="records-sticky"><span>설명은 비워 두어도 됩니다.</span><div className="records-tools"><button className="button secondary" disabled={busy} onClick={() => void save(false)}>임시 저장</button><button className="button" disabled={busy || selected.length < 2} onClick={() => void save(true)}>{busy ? "저장 중…" : "선생님께 제출"}</button></div></div>
    {message && <p role="status" className="records-message">{message}</p>}
    <details className="records-section"><summary>다른 기기에서 저장한 내용 확인</summary><button className="button secondary" onClick={async () => { try { setLatest(await request<RecordWorkspace>("/api/records?studentId=" + encodeURIComponent(workspace.student.id))); } catch (error) { setMessage((error as Error).message); } }}>최신 저장본과 비교</button>{latest && <><pre className="records-evidence-text">{latest.submission.selected.map(id => RECORD_ACTIVITIES.find(a => a.id === id)!.label).join(" · ")}{"\n"}{Object.entries(latest.submission.comments).map(([id, text]) => RECORD_ACTIVITIES.find(a => a.id === id)?.label + ": " + text).join("\n")}</pre><button className="button secondary" onClick={async () => { await onChanged(); setLatest(null); setMessage("현재 입력을 유지했습니다. 비교하여 고친 뒤 다시 저장해 주세요."); }}>현재 입력을 유지하고 계속 작성</button></>}</details>
    <RecordFileManager workspace={workspace} teacher={false} request={request} onChanged={onChanged} />
  </>;
}

export function TeacherRecordSettings({ settings, request, onSaved }: { settings: RecordSettings; request: RecordsRequest; onSaved: () => Promise<void> }) {
  const [style, setStyle] = useState(settings.style);
  const [opens, setOpens] = useState(localTime(settings.opensAt));
  const [deadline, setDeadline] = useState(localTime(settings.deadlineAt));
  const [revision, setRevision] = useState(settings.revision);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function save() {
    setBusy(true);
    try {
      const saved = await request<{ revision: number }>("/api/records", recordsPost("settings", undefined, { expectedRevision: revision, style, opensAt: fromSeoul(opens), deadlineAt: fromSeoul(deadline) }));
      setRevision(saved.revision); await onSaved(); setMessage("나의 작성 기준과 접수 기간을 저장했습니다.");
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }
  return <details className="card records-section"><summary className="records-summary">나의 세특 작성 기준 · 접수 기간</summary><fieldset disabled={busy}><label>문체와 강조할 기준<textarea rows={5} className="textarea" value={style} maxLength={12000} onChange={e => setStyle(e.target.value)} placeholder="선호하는 문장 길이, 강조할 역량, 피할 표현 등을 적어 주세요. 다른 선생님의 기준과 별도로 저장됩니다." /></label><div className="records-two-columns"><label>접수 시작 (한국 시간)<input type="datetime-local" value={opens} onChange={e => setOpens(e.target.value)} /></label><label>접수 마감 (한국 시간)<input type="datetime-local" value={deadline} onChange={e => setDeadline(e.target.value)} /></label></div><p className="records-hint">날짜를 비워 두면 해당 시점의 제한을 두지 않습니다. 마감 후에도 학생별로 수정 기간을 열 수 있습니다.</p><button className="button secondary" onClick={() => void save()}>내 기준 저장</button></fieldset>{settings.spreadsheetId && <p><a className="records-link" href={"https://docs.google.com/spreadsheets/d/" + settings.spreadsheetId + "/edit"} target="_blank" rel="noreferrer">내 스프레드시트 열기 ↗</a></p>}{message && <p className="records-message" role="status">{message}</p>}</details>;
}

export function TeacherRecordEditor({ workspace, request, onChanged, onDirty }: FormProps) {
  const draft = workspace.draft!;
  const evidence = workspace.evidence!;
  const [course1, setCourse1] = useState(draft.course1);
  const [course2, setCourse2] = useState(draft.course2);
  const [notes, setNotes] = useState(draft.notes);
  const [checks, setChecks] = useState(draft.checkedGroups);
  const [revision, setRevision] = useState(draft.revision);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [ai, setAi] = useState<RecordAiResult | null>(null);
  const [aiHash, setAiHash] = useState("");
  const [returnNote, setReturnNote] = useState("");
  const [returnUntil, setReturnUntil] = useState(localTime(new Date(Date.now() + 7 * 86400_000).toISOString()));
  const [history, setHistory] = useState<{ submissions: { revision: number; created_at: string }[]; drafts: { revision: number; created_at: string; snapshot: { course1?: string; course2?: string; status?: string } }[] } | null>(null);
  const [comparison, setComparison] = useState<RecordWorkspace | null>(null);
  const total = combinedRecordBytes(course1, course2);
  useEffect(() => { if (draft.evidence?.hash !== evidence.hash) setChecks([]); }, [evidence.hash, draft.evidence?.hash]);
  async function save(finalize: boolean) {
    setBusy(true); setMessage("");
    try {
      const saved = await request<{ revision: number }>("/api/records", recordsPost("draft", workspace.student.id, { expectedRevision: revision, expectedSubmissionRevision: workspace.submission.revision, expectedEvidenceHash: evidence.hash, course1, course2, notes, checkedGroups: checks, finalize }));
      setRevision(saved.revision); onDirty(false); await onChanged(); setMessage(finalize ? "교사 검토본을 확정했습니다. 확정본 내보내기로 스프레드시트에 저장할 수 있습니다." : "교사 작성본을 저장했습니다.");
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }
  async function generate() {
    setBusy(true); setMessage("과목별 근거로 초안을 만들고 있습니다. 현재 작성문은 유지됩니다.");
    try {
      const response = await request<{ result: RecordAiResult; evidenceHash: string }>("/api/records", recordsPost("generate", workspace.student.id, { evidenceHash: evidence.hash }));
      setAi(response.result); setAiHash(response.evidenceHash); setMessage("AI 초안과 근거를 검토한 뒤 작성란에 적용해 주세요.");
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }
  async function returnSubmission() {
    setBusy(true);
    try { await request("/api/records", recordsPost("return", workspace.student.id, { expectedRevision: workspace.submission.revision, note: returnNote, reopenedUntil: fromSeoul(returnUntil) })); await onChanged(); setMessage("학생에게 수정 요청을 표시하고 수정 기간을 열었습니다."); }
    catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }
  async function loadHistory() {
    try { setHistory(await request("/api/records?studentId=" + encodeURIComponent(workspace.student.id) + "&history=1")); }
    catch (error) { setMessage((error as Error).message); }
  }
  return <>
    <section className="card records-section"><div className="records-section-heading"><div><span className="records-kicker">{workspace.student.classNumber}반 · {workspace.student.loginId}</span><h2>{workspace.student.name}의 세특 작업실</h2></div><span className="badge">{draft.status === "final" ? "교사 확정본 있음" : "작성 중"}</span></div><p>과탐실 1 선택: {workspace.submission.selected.map(id => RECORD_ACTIVITIES.find(a => a.id === id)!.label).join(" · ") || "아직 선택하지 않음"}</p>{draft.evidence && (draft.evidence.hash !== evidence.hash || draft.sourceRevision !== workspace.submission.revision) && <p className="records-message">이전 검토 후 자료가 변경되었습니다. 현재 근거를 다시 확인해 주세요.</p>}</section>
    <section className="card records-section"><div className="records-section-heading"><h2>학생별 근거 자료</h2><span>{evidence.sources.length}개</span></div>{evidence.missing.length > 0 && <div className="records-notice"><strong>확인이 필요한 자료</strong><ul>{evidence.missing.map(item => <li key={item}>{item}</li>)}</ul><p>자료가 없는 활동을 수행하지 않았다고 판단하지 않습니다. 추가 원본이나 교사 관찰을 확인해 주세요.</p></div>}
      {[1, 2].map(course => <div className="records-evidence-group" key={course}><h3>과탐실 {course}</h3>{evidence.sources.filter(s => s.course === course).map(source => <details className="records-source" key={source.id} id={"source-" + encodeURIComponent(source.id)}><summary>{source.label} <small>{source.kind === "plan" ? "계획 자료" : source.kind === "student_statement" ? "학생의 설명" : source.kind === "exam_feedback" ? "교사 시험 피드백" : "활동 자료"}{!source.confirmed && source.kind !== "student_statement" ? " · 추출 미확인" : ""}</small></summary><pre className="records-evidence-text">{source.text}</pre><a className="records-link" href={source.sourceUrl} target="_blank" rel="noreferrer">원본 위치 열기 ↗</a>{source.attachments?.map(attachment => <p key={attachment.url}><a className="records-link" href={attachment.url}>{attachment.label} 내려받기</a></p>)}</details>)}</div>)}
      <fieldset className="records-checks" disabled={busy}><legend>과탐실 2 검토 확인</legend>{COURSE_TWO_GROUPS.map(id => <label key={id}><input type="checkbox" checked={checks.includes(id)} onChange={e => { setChecks(old => e.target.checked ? [...old, id] : old.filter(x => x !== id)); onDirty(true); }} />{RECORD_ACTIVITIES.find(a => a.id === id)!.label} 확인</label>)}</fieldset><p className="records-hint">없는 자료는 아래 교사 메모에 사유를 남깁니다. 팀 자료는 이 학생의 실제 역할과 구분해 읽어 주세요.</p>
    </section>
    <RecordFileManager workspace={workspace} teacher request={request} onChanged={onChanged} />
    <section className="card records-section"><div className="records-section-heading"><h2>세특 작성</h2><button className="button secondary" disabled={busy} onClick={() => void generate()}>{busy ? "처리 중…" : "근거로 AI 초안 만들기"}</button></div>
      {ai && <details className="records-ai" open><summary>AI 제안 · 교사 검토 필요</summary><h3>과탐실 1</h3><p>{ai.course1 || "활용 가능한 근거가 없습니다."}</p><h3>과탐실 2</h3><p>{ai.course2 || "활용 가능한 근거가 없습니다."}</p>{ai.warnings.length > 0 && <ul>{ai.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}<details><summary>문장별 근거 확인</summary>{ai.claims.map((claim, i) => <p key={i}>{claim.text}<br />{claim.evidenceIds.map(id => <a className="records-source-link" key={id} href={"#source-" + encodeURIComponent(id)}>{evidence.sources.find(s => s.id === id)?.label ?? id}</a>)}</p>)}</details><button className="button secondary" disabled={busy || aiHash !== evidence.hash} onClick={() => { setCourse1(ai.course1); setCourse2(ai.course2); setChecks([]); onDirty(true); }}>이 초안을 작성란에 적용</button>{aiHash !== evidence.hash && <p>자료가 변경되어 이 초안은 적용할 수 없습니다.</p>}</details>}
      <fieldset disabled={busy} className="records-editor"><label>과학탐구실험 1 <span>{recordBytes(course1)} 바이트</span><textarea rows={7} className="textarea" value={course1} maxLength={8000} onChange={e => { setCourse1(e.target.value); onDirty(true); }} placeholder="과탐실 1 활동 근거로 작성합니다." /></label><label>과학탐구실험 2 <span>{recordBytes(course2)} 바이트</span><textarea rows={7} className="textarea" value={course2} maxLength={8000} onChange={e => { setCourse2(e.target.value); onDirty(true); }} placeholder="팀 계획서·개별 일지·보고서와 본인 역할·개별 시험을 종합합니다." /></label><label>교사 메모 <span>학생에게 보이지 않음</span><textarea rows={3} className="textarea" value={notes} maxLength={10000} onChange={e => { setNotes(e.target.value); onDirty(true); }} placeholder="확인이 필요한 점, 관찰 근거, 자료가 부족한 사유 등을 남겨 주세요." /></label></fieldset>
      <div className="records-byte-bar"><div style={{ width: Math.min(100, total / 15) + "%", background: total > 1500 ? "var(--danger)" : "var(--brand)" }} /></div><div className="records-sticky"><span className={total > 1500 ? "records-over" : ""}><strong>{total.toLocaleString()}</strong> / 1,500 바이트 · {total <= 1500 ? 1500 - total + " 남음" : total - 1500 + " 초과"}</span><div className="records-tools"><button className="button secondary" disabled={busy} onClick={() => void save(false)}>작성본 저장</button><button className="button" disabled={busy || total > 1500 || !course1.trim() || !course2.trim() || !COURSE_TWO_GROUPS.every(g => checks.includes(g))} onClick={() => void save(true)}>검토 완료 · 확정</button></div></div>
      {message && <p className="records-message" role="status">{message}</p>}
      <details><summary>최신 저장본과 비교 · 내 입력 유지</summary><button className="button secondary" onClick={async () => { try { setComparison(await request<RecordWorkspace>("/api/records?studentId=" + encodeURIComponent(workspace.student.id))); } catch (error) { setMessage((error as Error).message); } }}>최신 저장본 불러오기</button>{comparison?.draft && <><h3>서버의 과탐실 1 작성본</h3><p>{comparison.draft.course1 || "비어 있음"}</p><h3>서버의 과탐실 2 작성본</h3><p>{comparison.draft.course2 || "비어 있음"}</p><button className="button secondary" onClick={async () => { setRevision(comparison.draft!.revision); setChecks([]); await onChanged(); setComparison(null); setMessage("내 작성란을 유지했습니다. 최신 근거와 비교하여 고친 뒤 저장해 주세요."); }}>비교했습니다 · 내 작성란으로 계속 작성</button></>}</details>
    </section>
    <details className="card records-section"><summary className="records-summary">학생에게 수정 요청</summary><fieldset disabled={busy}><label>학생에게 전달할 내용<textarea className="textarea" value={returnNote} onChange={e => setReturnNote(e.target.value)} maxLength={1000} rows={3} /></label><label>수정 가능 기한 (한국 시간)<input type="datetime-local" value={returnUntil} onChange={e => setReturnUntil(e.target.value)} /></label><button className="button secondary" disabled={!returnNote.trim() || !returnUntil} onClick={() => void returnSubmission()}>수정 요청하고 접수 다시 열기</button></fieldset></details>
    <details className="card records-section"><summary className="records-summary">제출·검토 이력</summary><button className="button secondary" onClick={() => void loadHistory()}>이력 불러오기</button>{history && <><h3>학생 제출 {history.submissions.length}회</h3>{history.submissions.map(s => <p key={s.revision}>제출 버전 {s.revision} · {shownTime(s.created_at)}</p>)}<h3>교사 작성본 {history.drafts.length}개</h3>{history.drafts.map(d => <details key={d.revision}><summary>버전 {d.revision} · {d.snapshot.status === "final" ? "확정" : "초안"} · {shownTime(d.created_at)}</summary><p>과탐실 1: {d.snapshot.course1}</p><p>과탐실 2: {d.snapshot.course2}</p></details>)}</>}</details>
  </>;
}
