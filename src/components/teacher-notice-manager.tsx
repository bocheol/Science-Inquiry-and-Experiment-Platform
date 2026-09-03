"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useToast } from "@/components/toast-provider";
import type { NoticeAudience, NoticeItem, NoticePriority } from "@/lib/notices";
import type { PushDeliverySummary } from "@/lib/push-notifications";

type TargetOptions = { classes: number[]; teams: Array<{ id: string; name: string; classNumber: number }> };

function seoulDate(value: string) {
  const date = new Date(new Date(value).getTime() + 9 * 60 * 60 * 1000);
  return `${date.getUTCFullYear()}. ${date.getUTCMonth() + 1}. ${date.getUTCDate()}. ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

export function TeacherNoticeManager({ targets }: { targets: TargetOptions }) {
  const { showToast } = useToast();
  const [notices, setNotices] = useState<NoticeItem[]>([]);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [audienceType, setAudienceType] = useState<NoticeAudience>("all");
  const [classNumber, setClassNumber] = useState(targets.classes[0] ?? 1);
  const [teamId, setTeamId] = useState("");
  const [priority, setPriority] = useState<NoticePriority>("normal");
  const [calendarStart, setCalendarStart] = useState("");
  const [calendarEnd, setCalendarEnd] = useState("");
  const [sendPush, setSendPush] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const teams = useMemo(() => targets.teams.filter((team) => team.classNumber === classNumber), [targets.teams, classNumber]);

  useEffect(() => {
    if (audienceType === "team" && !teams.some((team) => team.id === teamId)) setTeamId(teams[0]?.id ?? "");
  }, [audienceType, teamId, teams]);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/teacher/notices", { cache: "no-store" });
    const result = (await response.json()) as { notices?: NoticeItem[]; message?: string };
    if (!response.ok) throw new Error(result.message ?? "공지 목록을 불러오지 못했습니다.");
    setNotices(result.notices ?? []);
  }, []);

  useEffect(() => {
    void refresh().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "공지 목록을 불러오지 못했습니다."));
  }, [refresh]);

  function resetForm() {
    setTitle(""); setContent(""); setAudienceType("all"); setClassNumber(targets.classes[0] ?? 1);
    setTeamId(""); setPriority("normal"); setCalendarStart(""); setCalendarEnd(""); setSendPush(true); setEditingId(null); setError("");
  }

  function editNotice(notice: NoticeItem) {
    setEditingId(notice.id); setTitle(notice.title); setContent(notice.content); setAudienceType(notice.audienceType);
    setClassNumber(notice.classNumber ?? targets.classes[0] ?? 1); setTeamId(notice.teamId ?? ""); setPriority(notice.priority);
    setCalendarStart(notice.calendarStart ?? ""); setCalendarEnd(notice.calendarEnd ?? ""); setSendPush(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    const payload = {
      title, content, audienceType,
      classNumber: audienceType === "class" ? classNumber : null,
      teamId: audienceType === "team" ? teamId : null,
      priority, calendarStart: calendarStart || null, calendarEnd: calendarEnd || null, sendPush,
    };
    const response = await fetch("/api/teacher/notices", {
      method: editingId ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(editingId ? { action: "update", noticeId: editingId, ...payload } : payload),
    });
    const result = (await response.json()) as { message?: string; push?: PushDeliverySummary | null };
    setBusy(false);
    if (!response.ok) {
      const message = result.message ?? "공지를 저장하지 못했습니다.";
      setError(message); showToast(message, "error"); return;
    }
    if (result.push?.status === "disabled") {
      showToast("공지는 저장했지만 서버 푸시 설정이 없어 기기 알림은 보내지 않았습니다.", "error");
    } else if (result.push?.status === "failed") {
      showToast("공지는 저장했지만 기기 푸시 전송을 완료하지 못했습니다.", "error");
    } else if (result.push && result.push.targeted === 0) {
      showToast("공지는 저장했습니다. 푸시를 켠 대상 기기는 아직 없습니다.");
    } else if (result.push) {
      const suffix = result.push.failed ? ` (${result.push.failed}개 실패)` : "";
      showToast(`공지를 저장하고 ${result.push.sent}개 기기에 푸시를 보냈습니다.${suffix}`, result.push.failed ? "error" : "success");
    } else {
      showToast(editingId ? "공지를 수정하고 학생의 읽음 상태를 새로 시작했습니다." : "공지를 등록했습니다.");
    }
    resetForm(); await refresh();
  }

  async function changeArchive(notice: NoticeItem, archive: boolean) {
    if (archive && !window.confirm(`'${notice.title}' 공지를 보관할까요? 학생 화면에서는 숨겨집니다.`)) return;
    setBusy(true); setError("");
    const response = await fetch("/api/teacher/notices", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: archive ? "archive" : "restore", noticeId: notice.id }),
    });
    const result = (await response.json()) as { message?: string };
    setBusy(false);
    if (!response.ok) {
      const message = result.message ?? "공지 상태를 변경하지 못했습니다.";
      setError(message); showToast(message, "error"); return;
    }
    showToast(archive ? "공지를 보관했습니다." : "공지를 다시 게시했습니다.");
    await refresh();
  }

  const visible = notices.filter((notice) => (notice.status === "archived") === showArchived);

  return (
    <div className="stack teacher-notice-manager">
      <section className="card card-body">
        <div className="toolbar"><div><h2 className="section-heading">{editingId ? "공지 수정" : "새 공지 작성"}</h2><p className="section-subtitle">전체 학생, 특정 반 또는 특정 팀에 공지합니다. 날짜를 지정하면 학생 캘린더에도 표시됩니다.</p></div>{editingId ? <button className="button secondary" type="button" onClick={resetForm}>수정 취소</button> : null}</div>
        <div className="warning-box">학생 개인 이름·학번·비밀번호를 공지에 적지 마세요. 팀 공지는 현재 활성 팀원만 볼 수 있습니다.</div>
        {error ? <div className="error-box" role="alert">{error}</div> : null}
        <form className="notice-compose-form" onSubmit={submit}>
          <label className="field"><span>공지 대상</span><select className="select" value={audienceType} onChange={(event) => setAudienceType(event.target.value as NoticeAudience)}><option value="all">전체 학생</option><option value="class">특정 반</option><option value="team">특정 팀</option></select></label>
          {audienceType !== "all" ? <label className="field"><span>학급</span><select className="select" value={classNumber} onChange={(event) => setClassNumber(Number(event.target.value))}>{targets.classes.map((value) => <option key={value} value={value}>{value}반</option>)}</select></label> : null}
          {audienceType === "team" ? <label className="field"><span>팀</span><select className="select" value={teamId} onChange={(event) => setTeamId(event.target.value)} required>{teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label> : null}
          <label className="field"><span>표시 방식</span><select className="select" value={priority} onChange={(event) => setPriority(event.target.value as NoticePriority)}><option value="normal">일반 공지</option><option value="important">중요 공지 · 확인 전 팝업</option></select></label>
          <label className="field notice-compose-title"><span>제목</span><input className="input" value={title} onChange={(event) => setTitle(event.target.value)} minLength={2} maxLength={120} required /></label>
          <label className="field notice-compose-content"><span>내용</span><textarea className="textarea" value={content} onChange={(event) => setContent(event.target.value)} minLength={2} maxLength={5000} required /></label>
          <div className="notice-calendar-fields">
            <label className="field"><span>일정 시작일 · 선택</span><input className="input" type="date" value={calendarStart} onInput={(event) => { setCalendarStart(event.currentTarget.value); if (!event.currentTarget.value) setCalendarEnd(""); }} /></label>
            <label className="field"><span>일정 종료일 · 선택</span><input className="input" type="date" min={calendarStart || undefined} disabled={!calendarStart} value={calendarEnd} onInput={(event) => setCalendarEnd(event.currentTarget.value)} /></label>
          </div>
          <label className="push-send-option"><input type="checkbox" checked={sendPush} onChange={(event) => setSendPush(event.target.checked)} /> <span><b>대상 학생 기기에 푸시 알림 보내기</b><small>푸시를 허용한 기기에만 전송되며 공지 내용은 잠금 화면에 표시하지 않습니다.</small></span></label>
          <button className="button" disabled={busy || title.trim().length < 2 || content.trim().length < 2 || (audienceType === "team" && !teamId)}>{busy ? "저장 중…" : editingId ? "공지 수정" : "공지 게시"}</button>
        </form>
      </section>
      <section className="card card-body">
        <div className="toolbar"><div><h2 className="section-heading">게시한 공지</h2><p className="section-subtitle">공지 수정 시 학생들의 읽음 표시가 초기화되어 변경 내용을 다시 확인할 수 있습니다.</p></div><button className="button secondary" type="button" onClick={() => setShowArchived((value) => !value)}>{showArchived ? "게시 중 공지" : `보관 공지 ${notices.filter((notice) => notice.status === "archived").length}개`}</button></div>
        <div className="teacher-notice-list">
          {visible.map((notice) => <article className="teacher-notice-card" key={notice.id}><div className="toolbar"><div><div className="toolbar-group"><span className="badge">{notice.targetLabel}</span>{notice.priority === "important" ? <span className="badge feedback">중요</span> : null}{notice.calendarStart ? <span className="badge pending">일정</span> : null}</div><h3>{notice.title}</h3></div><div className="toolbar-group">{notice.status === "active" ? <><button className="button secondary" type="button" disabled={busy} onClick={() => editNotice(notice)}>수정</button><button className="button danger" type="button" disabled={busy} onClick={() => void changeArchive(notice, true)}>보관</button></> : <button className="button secondary" type="button" disabled={busy} onClick={() => void changeArchive(notice, false)}>복원</button>}</div></div><p>{notice.content}</p>{notice.calendarStart ? <small>일정 {notice.calendarStart}{notice.calendarEnd && notice.calendarEnd !== notice.calendarStart ? ` ~ ${notice.calendarEnd}` : ""} · </small> : null}<small>{notice.authorName} 교사 · {seoulDate(notice.createdAt)}</small></article>)}
          {!visible.length ? <p className="empty-state">{showArchived ? "보관된 공지가 없습니다." : "게시 중인 공지가 없습니다."}</p> : null}
        </div>
      </section>
    </div>
  );
}
