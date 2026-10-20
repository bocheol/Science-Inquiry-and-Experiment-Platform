"use client";
import { useState } from "react";
import type { getJournalTeacherSettings } from "@/lib/journal-teacher-settings";
type Settings = Awaited<ReturnType<typeof getJournalTeacherSettings>>;

export function JournalTeacherSettings({ initialData }: { initialData: Settings }) {
  const [data, setData] = useState(initialData);
  const [drafts, setDrafts] = useState<Record<string, string[]>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(id: string) {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/master/journal-teachers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ teacherId: id, classIds: drafts[id] ?? [], expectedClassIds: data.teachers.find(t => t.id === id)!.classIds }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "저장하지 못했습니다.");
      setData(result); setDrafts(current => { const next = { ...current }; delete next[id]; return next; }); setMessage("개인 일지 열람 권한을 저장했습니다.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "저장하지 못했습니다."); }
    finally { setBusy(false); }
  }
  return <section className="card stack"><h2>개인 일지 담당·공동관리 교사</h2><p>체크한 반의 개인 일지·사진·개인 근거를 포함한 시험을 열람할 수 있습니다. 공동관리 교사도 필요한 반만 선택합니다. 동아리는 기존 담당 교사 설정을 사용합니다.</p>
    {message ? <p role="status">{message}</p> : null}
    {data.teachers.map(teacher => <div className="stack" key={teacher.id}><strong>{teacher.name} ({teacher.login_id})</strong>{teacher.is_master ? <p>마스터 · 전체 학급 열람</p> : <div className="toolbar-group">{data.classes.map(c => <label key={c.id}><input type="checkbox" disabled={busy} checked={(drafts[teacher.id] ?? teacher.classIds).includes(c.id)} onChange={event => { const selected = drafts[teacher.id] ?? teacher.classIds; setDrafts({ ...drafts, [teacher.id]: event.target.checked ? [...selected, c.id] : selected.filter(id => id !== c.id) }); }} />{c.class_number}반</label>)}<button className="button secondary" disabled={busy || !drafts[teacher.id]} onClick={() => void save(teacher.id)}>이 교사 권한 저장</button></div>}</div>)}
    <button className="button ghost" disabled={busy} onClick={() => { if (window.confirm("미저장 권한 선택을 버리고 최신 목록을 불러올까요?")) window.location.reload(); }}>최신 목록 다시 불러오기</button>
  </section>;
}
