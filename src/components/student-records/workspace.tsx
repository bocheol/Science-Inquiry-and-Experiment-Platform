"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RecordSettings, RecordStudent, RecordWorkspace } from "@/lib/student-records/model";
import { StudentRecordForm, TeacherRecordEditor, TeacherRecordSettings } from "./forms";
import { RecordBulkUpload } from "./files";

export type RecordsRequest = <T>(path: string, init?: RequestInit) => Promise<T>;
export const recordsPost = (action: string, studentId: string | undefined, data: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, studentId, data }) });

export function StudentRecordsWorkspace({ user }: { user: { id: string; role: "teacher" | "student" } }) {
  const [students, setStudents] = useState<RecordStudent[]>([]);
  const [settings, setSettings] = useState<RecordSettings | null>(null);
  const [workspace, setWorkspace] = useState<RecordWorkspace | null>(null);
  const [message, setMessage] = useState("");
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState("");
  const [classFilter, setClassFilter] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportUrl, setExportUrl] = useState("");
  const selectionEpoch = useRef(0);
  const activeSession = useRef(true);
  const identityEpoch = useRef(0);
  const exportRequest = useRef("");
  const request: RecordsRequest = useCallback(async <T,>(path: string, init: RequestInit = {}) => {
    const response = await fetch(path, { ...init, cache: "no-store", headers: { ...Object.fromEntries(new Headers(init.headers).entries()), "x-records-user": user.id } });
    const result = await response.json() as T & { message?: string };
    if (response.status === 403) { activeSession.current = false; setReady(false); setWorkspace(null); setStudents([]); }
    if (!response.ok) throw new Error(result.message || "요청을 처리하지 못했습니다.");
    if (!activeSession.current && !path.includes("identity=1")) throw new Error("현재 로그인 계정을 다시 확인해 주세요.");
    return result;
  }, [user.id]);

  const refreshIndex = useCallback(async () => {
    if (user.role !== "teacher") return;
    const data = await request<{ students: RecordStudent[]; settings: RecordSettings }>("/api/records");
    setStudents(data.students); setSettings(data.settings);
  }, [request, user.role]);
  const refreshStudent = useCallback(async (id: string) => {
    const epoch = ++selectionEpoch.current;
    const data = await request<RecordWorkspace>("/api/records?studentId=" + encodeURIComponent(id));
    if (epoch === selectionEpoch.current) setWorkspace(data);
  }, [request]);

  useEffect(() => {
    let mounted = true;
    const check = async () => {
      const epoch = ++identityEpoch.current;
      setReady(false);
      try {
        const identity = await request<{ id: string }>("/api/records?identity=1");
        if (mounted && epoch === identityEpoch.current && document.visibilityState !== "hidden") {
          activeSession.current = identity.id === user.id;
          setReady(activeSession.current);
        }
      } catch (error) { if (mounted && epoch === identityEpoch.current) setMessage((error as Error).message); }
    };
    const visibility = () => { if (document.visibilityState === "hidden") { identityEpoch.current++; setReady(false); } else void check(); };
    const pageHide = () => { identityEpoch.current++; setReady(false); };
    void check().then(async () => {
      if (!activeSession.current || !mounted) return;
      try {
        if (user.role === "teacher") await refreshIndex();
        else { setSelectedId(user.id); await refreshStudent(user.id); }
      } catch (error) { if (mounted) setMessage((error as Error).message); }
      finally { if (mounted) setLoading(false); }
    });
    document.addEventListener("visibilitychange", visibility); window.addEventListener("pageshow", check); window.addEventListener("pagehide", pageHide); window.addEventListener("focus", check);
    return () => { mounted = false; identityEpoch.current++; document.removeEventListener("visibilitychange", visibility); window.removeEventListener("pageshow", check); window.removeEventListener("pagehide", pageHide); window.removeEventListener("focus", check); };
  }, [request, refreshIndex, refreshStudent, user.id, user.role]);
  useEffect(() => {
    if (!dirty) return;
    const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", leave); return () => window.removeEventListener("beforeunload", leave);
  }, [dirty]);

  async function selectStudent(id: string) {
    if (dirty && !window.confirm("아직 저장하지 않은 작성 내용이 있습니다. 학생을 바꾸면 이 입력이 사라집니다. 이동할까요?")) return;
    setDirty(false); setSelectedId(id); setWorkspace(null); setMessage("");
    try { await refreshStudent(id); } catch (error) { setMessage((error as Error).message); }
  }
  async function exportFinals() {
    setExporting(true); setMessage("");
    exportRequest.current ||= crypto.randomUUID();
    try {
      const result = await request<{ url: string; count: number }>("/api/records", recordsPost("export", undefined, { requestId: exportRequest.current }));
      setExportUrl(result.url); setMessage(result.count + "명의 확정본을 내 스프레드시트의 새 탭에 저장했습니다."); exportRequest.current = "";
    } catch (error) { setMessage((error as Error).message); }
    finally { setExporting(false); }
  }

  return <>
    <div className="records-title"><div><span className="records-kicker">과학탐구실험 1 · 2</span><h1>세특 커스텀</h1><p>{user.role === "teacher" ? "학생별 근거를 확인하고, 두 과목의 세특을 함께 다듬습니다." : "나의 활동을 고르고, 선생님께 보여 드릴 자료를 모아 주세요."}</p></div><span className="records-limit">두 과목 합계 <strong>1,500</strong> 바이트</span></div>
    {message && <p className="records-message" role="status">{message}</p>}
    {!ready && <section className="card"><p>로그인 계정을 확인하고 있습니다. 계정이 바뀌었다면 페이지를 새로 열어 주세요.</p><a className="button secondary" href="/records">다시 열기</a></section>}
    <div hidden={!ready}>{loading ? <p role="status">세특 자료를 불러오는 중입니다.</p> : <>
      {user.role === "teacher" && <>
        <div className="records-tools"><button className="button" disabled={exporting} onClick={() => void exportFinals()}>{exporting ? "내보내는 중…" : "확정본을 내 스프레드시트로"}</button>{exportUrl && <a className="button secondary" href={exportUrl} target="_blank" rel="noreferrer">저장한 결과 열기</a>}<span>학생 화면에는 교사 작성본이 보이지 않습니다.</span></div>
        {settings && <TeacherRecordSettings settings={settings} request={request} onSaved={refreshIndex} />}
        {students.length ? <RecordBulkUpload students={students} request={request} onChanged={async () => { await refreshIndex(); if (selectedId) await refreshStudent(selectedId); }} /> : <section className="card"><h2>담당 반 연결을 확인해 주세요</h2><p>현재 계정에 연결된 담당 반이 없습니다. 계정 이름·아이디와 담당 반이 확인된 후 자료를 열 수 있습니다.</p></section>}
      </>}
      <div className={user.role === "teacher" ? "records-layout" : ""}>
        {user.role === "teacher" && <aside className="records-roster card"><h2>담당 학생 <span>{students.length}명</span></h2><label>학급<select value={classFilter} onChange={e => setClassFilter(Number(e.target.value))}><option value={0}>담당 반 전체</option>{[...new Set(students.map(s => s.classNumber))].map(n => <option value={n} key={n}>{n}반</option>)}</select></label><div className="records-roster-list">{students.filter(s => !classFilter || s.classNumber === classFilter).map(s => <button type="button" className={selectedId === s.id ? "active" : ""} key={s.id} onClick={() => void selectStudent(s.id)}><span>{s.loginId} {s.name}</span><small>{s.status === "inactive" ? "비활성 계정 · " : ""}{s.submissionStatus === "submitted" ? "학생 제출" : s.submissionStatus === "returned" ? "수정 요청" : "작성 중"} · {s.draftStatus === "final" ? "교사 확정" : "검토 대기"}</small></button>)}</div></aside>}
        <div className="records-main">{workspace ? user.role === "teacher" ? <TeacherRecordEditor key={workspace.student.id} workspace={workspace} request={request} onDirty={setDirty} onChanged={async () => { await refreshStudent(workspace.student.id); await refreshIndex(); }} /> : <StudentRecordForm key={workspace.student.id} workspace={workspace} request={request} onDirty={setDirty} onChanged={() => refreshStudent(workspace.student.id)} /> : user.role === "teacher" && students.length > 0 ? <section className="card records-empty"><h2>학생을 선택해 주세요</h2><p>활동 자료, 세특 초안, 검토 이력을 한 화면에서 확인할 수 있습니다.</p></section> : null}</div>
      </div>
    </>}</div>
  </>;
}
