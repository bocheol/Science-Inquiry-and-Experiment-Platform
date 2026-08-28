"use client";

import { useMemo, useState } from "react";
import type { IssuedCredential } from "@/lib/roster";
import type { TeacherDashboardData } from "@/lib/teacher-data";

type Credential = Omit<IssuedCredential, "classNumber"> & { classNumber?: number };

function statusLabel(status: string | null) {
  const labels: Record<string, string> = {
    draft: "작성 중",
    pending: "승인 대기",
    feedback: "수정 요청",
    approved: "승인",
    reapproval_required: "재승인 필요",
  };
  return status ? labels[status] ?? status : "시작 전";
}

function reportStatusLabel(status: string | null) {
  const labels: Record<string, string> = { draft: "작성 중", submitted: "검토 대기", feedback: "수정 요청", reviewed: "확인 완료" };
  return status ? labels[status] ?? status : "시작 전";
}

function recentLabel(value: string | null) {
  if (!value) return "활동 없음";
  const seoul = new Date(new Date(value).getTime() + 9 * 60 * 60 * 1000);
  return `${seoul.getUTCMonth() + 1}. ${seoul.getUTCDate()}. ${String(seoul.getUTCHours()).padStart(2, "0")}:${String(seoul.getUTCMinutes()).padStart(2, "0")}`;
}

export function TeacherDashboard({ initialData }: { initialData: TeacherDashboardData }) {
  const [data, setData] = useState(initialData);
  const [classNumber, setClassNumber] = useState(9);
  const [progressClassNumber, setProgressClassNumber] = useState(0);
  const [attentionFilter, setAttentionFilter] = useState<"all" | "teacher" | "student">("all");
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const visibleStudents = useMemo(
    () => data.students.filter((student) => student.classNumber === classNumber),
    [data.students, classNumber],
  );
  const visibleTeams = useMemo(
    () => data.teams.filter((team) => team.classNumber === classNumber),
    [data.teams, classNumber],
  );
  const progressTeams = useMemo(
    () => data.teams.filter((team) =>
      (!progressClassNumber || team.classNumber === progressClassNumber)
      && (attentionFilter === "all" || team.attention === attentionFilter)),
    [data.teams, progressClassNumber, attentionFilter],
  );
  const progressScopeTeams = useMemo(
    () => data.teams.filter((team) => !progressClassNumber || team.classNumber === progressClassNumber),
    [data.teams, progressClassNumber],
  );
  const progressSummary = useMemo(() => ({
    members: progressScopeTeams.reduce((sum, team) => sum + team.memberCount, 0),
    journalStudents: progressScopeTeams.reduce((sum, team) => sum + team.journalStudentCount, 0),
    approvedPlans: progressScopeTeams.filter((team) => team.planStatus === "approved").length,
    submittedReports: progressScopeTeams.filter((team) => team.reportStatus === "submitted" || team.reportStatus === "reviewed").length,
    teacherAttention: progressScopeTeams.filter((team) => team.attention === "teacher").length,
  }), [progressScopeTeams]);
  const exportClassQuery = progressClassNumber ? `&classNumber=${progressClassNumber}` : "";

  async function refresh() {
    const response = await fetch("/api/teacher/roster", { cache: "no-store" });
    if (response.ok) setData((await response.json()) as TeacherDashboardData);
  }

  async function uploadRoster(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    const formData = new FormData(event.currentTarget);
    const response = await fetch("/api/teacher/roster", { method: "POST", body: formData });
    const result = (await response.json()) as { message?: string; total?: number; issued?: Credential[] };
    setBusy(false);
    if (!response.ok) return setError(result.message ?? "명단을 등록하지 못했습니다.");
    setCredentials(result.issued ?? []);
    setMessage(`${result.total ?? 0}명을 확인했고, 새 계정 ${result.issued?.length ?? 0}개를 만들었습니다.`);
    await refresh();
  }

  async function teamAction(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    const response = await fetch("/api/teacher/teams", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as { message?: string };
    setBusy(false);
    if (!response.ok) return setError(result.message ?? "팀을 변경하지 못했습니다.");
    await refresh();
  }

  async function resetPassword(studentId: string) {
    if (!window.confirm("새 임시 비밀번호를 발급할까요? 기존 비밀번호는 즉시 사용할 수 없게 됩니다.")) return;
    setBusy(true);
    const response = await fetch("/api/teacher/password-reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ studentId }),
    });
    const result = (await response.json()) as { message?: string; credential?: Credential };
    setBusy(false);
    if (!response.ok || !result.credential) return setError(result.message ?? "초기화하지 못했습니다.");
    setCredentials([result.credential]);
    setMessage("새 임시 비밀번호를 발급했습니다. 이 화면을 닫으면 다시 확인할 수 없습니다.");
    await refresh();
  }

  return (
    <div className="stack">
      {error ? <div className="error-box" role="alert">{error}</div> : null}
      {message ? <div className="notice-box">{message}</div> : null}

      <section className="card progress-dashboard">
        <div className="card-body">
          <div className="toolbar">
            <div>
              <h2 className="section-heading">학급별 탐구 진척</h2>
              <p className="section-subtitle">계획서·개인 일지·보고서 상태와 교사가 처리할 항목을 함께 봅니다.</p>
            </div>
            <div className="toolbar-group no-print">
              <label className="label" htmlFor="progressClassFilter">학급</label>
              <select className="select" id="progressClassFilter" value={progressClassNumber} onChange={(event) => setProgressClassNumber(Number(event.target.value))}>
                <option value={0}>전체 학급</option>
                {Array.from({ length: 9 }, (_, index) => index + 1).map((number) => <option key={number} value={number}>{number}반</option>)}
              </select>
              <label className="label" htmlFor="attentionFilter">상태</label>
              <select className="select" id="attentionFilter" value={attentionFilter} onChange={(event) => setAttentionFilter(event.target.value as "all" | "teacher" | "student")}>
                <option value="all">전체 상태</option>
                <option value="teacher">교사 확인 필요</option>
                <option value="student">학생 진행 필요</option>
              </select>
              <a className="button secondary" href={`/api/teacher/progress-export?format=xlsx${exportClassQuery}`}>Excel 내려받기</a>
              <a className="button ghost" href={`/api/teacher/progress-export?format=csv${exportClassQuery}`}>CSV 내려받기</a>
            </div>
          </div>
          <div className="grid progress-metrics">
            <article className="metric"><span>팀</span><strong>{progressScopeTeams.length}</strong></article>
            <article className="metric"><span>계획 승인</span><strong>{progressSummary.approvedPlans}<small>/{progressScopeTeams.length}</small></strong></article>
            <article className="metric"><span>일지 작성 학생</span><strong>{progressSummary.journalStudents}<small>/{progressSummary.members}</small></strong></article>
            <article className="metric"><span>보고서 제출</span><strong>{progressSummary.submittedReports}<small>/{progressScopeTeams.length}</small></strong></article>
            <article className="metric attention-metric"><span>교사 확인 필요</span><strong>{progressSummary.teacherAttention}</strong></article>
          </div>
        </div>
        <div className="table-wrap">
          <table className="data-table progress-table">
            <thead><tr><th>학급·팀</th><th>탐구 주제</th><th>이론 탐색</th><th>계획서</th><th>개인 일지</th><th>보고서</th><th>확인 필요</th><th>최근 활동</th><th>바로가기</th></tr></thead>
            <tbody>
              {progressTeams.map((team) => (
                <tr key={team.id} className={team.attention === "teacher" ? "needs-teacher" : ""}>
                  <td><b>{team.classNumber}반 {team.name}</b><br /><small>{team.memberCount}명</small></td>
                  <td>{team.topic || "주제 탐색 중"}</td>
                  <td>질문 {team.messageCount}회</td>
                  <td><span className={`badge ${team.planStatus ?? ""}`}>{statusLabel(team.planStatus)}</span></td>
                  <td><b>{team.journalStudentCount}/{team.memberCount}명</b><br /><small>총 {team.journalEntryCount}차시</small></td>
                  <td><span className={`badge ${team.reportStatus === "feedback" ? "feedback" : team.reportStatus === "submitted" ? "pending" : ""}`}>{reportStatusLabel(team.reportStatus)}</span></td>
                  <td>{team.attentionReasons.length ? <span className={`badge ${team.attention === "teacher" ? "pending" : "feedback"}`}>{team.attentionReasons.join(" · ")}</span> : <span className="badge">없음</span>}</td>
                  <td>{recentLabel(team.lastActivityAt)}</td>
                  <td>{team.sessionId ? <a className="button ghost" href={`/teacher/team/${team.id}`}>팀 확인</a> : "—"}</td>
                </tr>
              ))}
              {!progressTeams.length ? <tr><td colSpan={9} className="empty-state">선택한 조건에 해당하는 팀이 없습니다.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid four metrics-grid no-print" aria-label="계정과 팀 편성 현황">
        <article className="card metric"><span>등록 학생</span><strong>{data.counts.students}</strong></article>
        <article className="card metric"><span>편성 팀</span><strong>{data.counts.teams}</strong></article>
        <article className="card metric"><span>미배정 학생</span><strong>{data.counts.unassigned}</strong></article>
        <article className="card metric"><span>확인할 계획서</span><strong>{data.counts.pendingPlans}</strong></article>
      </section>

      <section className="card card-body no-print">
        <h2 className="section-heading">학생 명단 등록</h2>
        <p className="section-subtitle">열 제목은 원본과 같은 ‘반, 번호, 성명, 조 번호’를 사용합니다. 기존 학생의 비밀번호는 재업로드해도 바뀌지 않습니다.</p>
        <form onSubmit={uploadRoster} className="drop-zone">
          <div>
            <div style={{ fontSize: 28, marginBottom: 8 }}>📊</div>
            <input name="file" type="file" accept=".xlsx,.xls" required />
            <div style={{ marginTop: 12 }}><button className="button" disabled={busy}>{busy ? "처리 중…" : "명단 등록"}</button></div>
          </div>
        </form>
      </section>

      {credentials.length ? (
        <section className="card card-body">
          <div className="toolbar no-print">
            <div>
              <h2 className="section-heading">임시 로그인 카드</h2>
              <p className="section-subtitle">비밀번호 원문은 지금만 표시됩니다.</p>
            </div>
            <div className="toolbar-group">
              <button className="button" onClick={() => window.print()}>A4 인쇄 / PDF 저장</button>
              <button className="button secondary" onClick={() => setCredentials([])}>닫기</button>
            </div>
          </div>
          <div className="credential-grid">
            {credentials.map((credential) => (
              <article className="credential-card" key={`${credential.loginId}-${credential.temporaryPassword}`}>
                <h3>🔬 과탐실 첫 로그인</h3>
                <dl>
                  <dt>이름</dt><dd>{credential.name}</dd>
                  <dt>아이디</dt><dd>{credential.loginId}</dd>
                  <dt>임시 비밀번호</dt><dd>{credential.temporaryPassword}</dd>
                </dl>
                <small>처음 로그인하면 본인 비밀번호로 변경합니다.</small>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <section className="card no-print">
        <div className="card-body">
          <div className="toolbar">
            <div>
              <h2 className="section-heading">팀 편성</h2>
              <p className="section-subtitle">학생 이동·제거 기록은 교사용 이력으로 남습니다.</p>
            </div>
            <div className="toolbar-group">
              <label className="label" htmlFor="classFilter">학급</label>
              <select className="select" id="classFilter" value={classNumber} onChange={(event) => setClassNumber(Number(event.target.value))}>
                {Array.from({ length: 9 }, (_, index) => index + 1).map((number) => <option key={number} value={number}>{number}반</option>)}
              </select>
              <button className="button ghost" disabled={busy} onClick={() => teamAction({ action: "create", classNumber, teamNumber: Math.max(0, ...visibleTeams.map((team) => team.teamNumber)) + 1 })}>+ 팀 추가</button>
            </div>
          </div>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>학번</th><th>이름</th><th>현재 팀</th><th>팀장</th><th>계정</th><th>관리</th></tr></thead>
            <tbody>
              {visibleStudents.map((student) => (
                <tr key={student.id}>
                  <td>{student.loginId}</td>
                  <td><b>{student.name}</b></td>
                  <td>
                    <select
                      className="select"
                      value={student.teamId ?? ""}
                      disabled={busy}
                      onChange={(event) => event.target.value ? teamAction({ action: "assign", studentId: student.id, teamId: event.target.value }) : student.teamId && teamAction({ action: "remove", studentId: student.id, teamId: student.teamId })}
                    >
                      <option value="">미배정</option>
                      {visibleTeams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
                    </select>
                  </td>
                  <td>{student.teamId ? <button className={`button ${student.isLeader ? "" : "secondary"}`} disabled={busy || student.isLeader} onClick={() => teamAction({ action: "leader", studentId: student.id, teamId: student.teamId })}>{student.isLeader ? "팀장" : "지정"}</button> : "—"}</td>
                  <td><span className={`badge ${student.mustChangePassword ? "pending" : ""}`}>{student.mustChangePassword ? "첫 로그인 전" : "사용 중"}</span></td>
                  <td><button className="button ghost" disabled={busy} onClick={() => resetPassword(student.id)}>비밀번호 초기화</button></td>
                </tr>
              ))}
              {!visibleStudents.length ? <tr><td colSpan={6} className="empty-state">이 학급에 등록된 학생이 없습니다.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

    </div>
  );
}
