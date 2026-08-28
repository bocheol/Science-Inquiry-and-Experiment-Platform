"use client";

import { useEffect, useMemo, useState } from "react";
import type { TeacherJournalData } from "@/lib/journal-service";

export function TeacherJournalReview({ teamId }: { teamId: string }) {
  const [data, setData] = useState<TeacherJournalData | null>(null);
  const [selectedStudentId, setSelectedStudentId] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await fetch(`/api/teacher/journals?teamId=${encodeURIComponent(teamId)}`, { cache: "no-store" });
      const result = (await response.json()) as TeacherJournalData & { message?: string };
      if (cancelled) return;
      if (!response.ok) return setError(result.message ?? "실험 일지를 불러오지 못했습니다.");
      setData(result);
      setSelectedStudentId((current) => current || result.members[0]?.id || "");
    })();
    return () => { cancelled = true; };
  }, [teamId]);

  const selected = useMemo(() => data?.members.find((member) => member.id === selectedStudentId) ?? null, [data, selectedStudentId]);

  return (
    <section className="card card-body">
      <div className="toolbar"><div><h2 className="section-heading">개인 실험 일지</h2><p className="section-subtitle">학생끼리는 볼 수 없으며, 제거된 학생의 과거 기록도 교사용으로 보존됩니다.</p></div>{data ? <span className="badge">총 {data.members.reduce((sum, member) => sum + member.journals.length, 0)}건</span> : null}</div>
      {error ? <div className="error-box">{error}</div> : null}
      {!data && !error ? <div className="empty-state">일지를 불러오는 중입니다…</div> : null}
      {data ? <div className="teacher-journal-layout">
        <div className="teacher-journal-members">{data.members.map((member) => <button type="button" className={`journal-member-button ${member.id === selectedStudentId ? "active" : ""}`} key={member.id} onClick={() => setSelectedStudentId(member.id)}><span><b>{member.name}</b> ({member.loginId})</span><span>{member.journals.length}차시 {!member.isActive ? <em>팀에서 제거됨</em> : null}</span></button>)}</div>
        <div className="teacher-journal-entries">{selected?.journals.map((journal) => <article className="journal-read-card" key={journal.id}><div className="toolbar"><h3>{journal.sessionNumber}차시</h3><span>{journal.date}</span></div><dl><dt>오늘 한 일</dt><dd>{journal.activities}</dd><dt>관찰 결과</dt><dd>{journal.observations}</dd><dt>느낀 점 / 궁금한 점</dt><dd>{journal.reflections || "작성 없음"}</dd></dl>{journal.images.length ? <div className="journal-photo-grid">{journal.images.map((image) => <a href={image.url} target="_blank" rel="noreferrer" key={image.id}><img src={image.url} alt={`${selected.name} 학생의 ${journal.sessionNumber}차시 실험 사진`} /></a>)}</div> : null}</article>)}{selected && !selected.journals.length ? <div className="empty-state">이 학생이 작성한 일지가 없습니다.</div> : null}{!selected ? <div className="empty-state">팀원이 없습니다.</div> : null}</div>
      </div> : null}
    </section>
  );
}
