"use client";

import { Fragment, useMemo, useState } from "react";
import type { IssuedCredential } from "@/lib/roster";
import type { TeacherDashboardData } from "@/lib/teacher-data";
import { useToast } from "@/components/toast-provider";
import { findNextAvailableTeamNumber } from "@/lib/team-number";

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
  const { showToast } = useToast();
  const [data, setData] = useState(initialData);
  const [classNumber, setClassNumber] = useState(9);
  const [progressClassNumber, setProgressClassNumber] = useState(0);
  const [attentionFilter, setAttentionFilter] = useState<"all" | "teacher" | "student">("all");
  const [expandedClasses, setExpandedClasses] = useState<Record<number, boolean>>({});
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [archivingTeamId, setArchivingTeamId] = useState<string | null>(null);
  const [archiveConfirmation, setArchiveConfirmation] = useState("");
  const [newStudentLoginId, setNewStudentLoginId] = useState("");
  const [newStudentName, setNewStudentName] = useState("");
  const [showInactiveStudents, setShowInactiveStudents] = useState(false);
  const [deactivatingStudentId, setDeactivatingStudentId] = useState<string | null>(null);
  const [deactivateConfirmation, setDeactivateConfirmation] = useState("");

  const visibleStudents = useMemo(
    () => data.students.filter((student) => student.classNumber === classNumber),
    [data.students, classNumber],
  );
  const visibleTeams = useMemo(
    () => data.teams.filter((team) => team.classNumber === classNumber),
    [data.teams, classNumber],
  );
  const visibleInactiveStudents = useMemo(
    () => data.inactiveStudents.filter((student) => student.classNumber === classNumber),
    [data.inactiveStudents, classNumber],
  );
  const visibleArchivedTeams = useMemo(
    () => data.archivedTeams.filter((team) => team.classNumber === classNumber),
    [data.archivedTeams, classNumber],
  );
  const nextTeamNumber = useMemo(
    () => findNextAvailableTeamNumber([
      ...visibleTeams.map((team) => team.teamNumber),
      ...visibleArchivedTeams.map((team) => team.teamNumber),
    ]),
    [visibleTeams, visibleArchivedTeams],
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
    if (!response.ok) {
      const text = result.message ?? "명단을 등록하지 못했습니다.";
      setError(text); showToast(text, "error"); return;
    }
    setCredentials(result.issued ?? []);
    setMessage(`${result.total ?? 0}명을 확인했고, 새 계정 ${result.issued?.length ?? 0}개를 만들었습니다.`);
    showToast("학생 명단을 등록했습니다.");
    await refresh();
  }

  async function addSingleStudent(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(""); setMessage("");
    const response = await fetch("/api/teacher/students", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ loginId: newStudentLoginId, name: newStudentName }),
    });
    const result = (await response.json()) as { message?: string; credential?: Credential };
    setBusy(false);
    if (!response.ok || !result.credential) {
      const text = result.message ?? "학생을 추가하지 못했습니다.";
      setError(text); showToast(text, "error"); return;
    }
    setCredentials([result.credential]);
    setMessage("학생 계정을 추가했습니다. 임시 비밀번호는 지금만 확인할 수 있습니다.");
    setNewStudentLoginId(""); setNewStudentName("");
    setClassNumber(result.credential.classNumber ?? classNumber);
    showToast("학생 계정을 추가했습니다.");
    await refresh();
  }

  async function changeStudentStatus(action: "deactivate" | "restore", studentId: string) {
    setBusy(true); setError("");
    const response = await fetch("/api/teacher/students", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, studentId }),
    });
    const result = (await response.json()) as { message?: string };
    setBusy(false);
    if (!response.ok) {
      const text = result.message ?? "학생 계정을 변경하지 못했습니다.";
      setError(text); showToast(text, "error"); return false;
    }
    showToast(action === "deactivate" ? "학생 계정을 비활성화했습니다." : "학생 계정을 복원했습니다.");
    setDeactivatingStudentId(null); setDeactivateConfirmation("");
    await refresh();
    return true;
  }

  async function teamAction(body: Record<string, unknown>, successMessage = "팀 정보를 변경했습니다.") {
    setBusy(true);
    setError("");
    const response = await fetch("/api/teacher/teams", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as { message?: string };
    setBusy(false);
    if (!response.ok) {
      const text = result.message ?? "팀을 변경하지 못했습니다.";
      setError(text); showToast(text, "error"); return false;
    }
    showToast(successMessage);
    await refresh();
    return true;
  }

  function startArchive(teamId: string) {
    setArchivingTeamId(teamId);
    setArchiveConfirmation("");
    setError("");
  }

  async function confirmArchive(team: TeacherDashboardData["teams"][number]) {
    const changed = await teamAction(
      { action: "archive", teamId: team.id, confirmation: archiveConfirmation },
      `${team.classNumber}반 ${team.name}을(를) 보관했습니다.`,
    );
    if (changed) {
      setArchivingTeamId(null);
      setArchiveConfirmation("");
    }
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
    if (!response.ok || !result.credential) {
      const text = result.message ?? "초기화하지 못했습니다.";
      setError(text); showToast(text, "error"); return;
    }
    setCredentials([result.credential]);
    setMessage("새 임시 비밀번호를 발급했습니다. 이 화면을 닫으면 다시 확인할 수 없습니다.");
    showToast("새 임시 비밀번호를 발급했습니다.");
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
        <div className="toolbar-group card-body no-print"><button className="button secondary" onClick={() => setExpandedClasses(Object.fromEntries(Array.from({length:9},(_,i)=>[i+1,true])))}>모든 반 펼치기</button><button className="button secondary" onClick={() => setExpandedClasses({})}>모든 반 접기</button></div>
        {[...new Set(progressTeams.map(team=>team.classNumber))].sort((a,b)=>a-b).map(number => <details className="class-group" key={number} open={Boolean(expandedClasses[number])} onToggle={event=>{const open=event.currentTarget.open;setExpandedClasses(previous=>previous[number]===open?previous:{...previous,[number]:open});}}>
        <summary>{number}반 <span className="badge">{progressTeams.filter(t=>t.classNumber===number).length}팀</span> <span>교사 확인 {progressTeams.filter(t=>t.classNumber===number&&t.attention==='teacher').length}팀</span></summary>
        <div className="table-wrap">
          <table className="data-table progress-table">
            <thead><tr><th>학급·팀</th><th>탐구 주제</th><th>이론 탐색</th><th>계획서</th><th>개인 일지</th><th>보고서</th><th>확인 필요</th><th>최근 활동</th><th>바로가기</th></tr></thead>
            <tbody>
              {progressTeams.filter(team=>team.classNumber===number).map((team) => (
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
        </details>)}
        {!progressTeams.length ? <p className="empty-state">선택한 조건에 해당하는 팀이 없습니다.</p> : null}
      </section>

      <section className="grid four metrics-grid no-print" aria-label="계정과 팀 편성 현황">
        <article className="card metric"><span>등록 학생</span><strong>{data.counts.students}</strong></article>
        <article className="card metric"><span>편성 팀</span><strong>{data.counts.teams}</strong></article>
        <article className="card metric"><span>미배정 학생</span><strong>{data.counts.unassigned}</strong></article>
        <article className="card metric"><span>확인할 계획서</span><strong>{data.counts.pendingPlans}</strong></article>
      </section>

      <section className="card card-body no-print">
        <h2 className="section-heading">학생 개별 추가</h2>
        <p className="section-subtitle">전입·누락 학생은 5자리 학번과 이름으로 바로 추가합니다. 새 학생은 미배정 상태로 등록됩니다.</p>
        <form className="student-add-form" onSubmit={addSingleStudent}>
          <div>
            <label className="label" htmlFor="newStudentLoginId">5자리 학번</label>
            <input id="newStudentLoginId" className="input" inputMode="numeric" pattern="1(0[1-9])(0[1-9]|[1-9][0-9])" maxLength={5} value={newStudentLoginId} onChange={(event) => setNewStudentLoginId(event.target.value.replace(/\D/g, "").slice(0, 5))} placeholder="예: 10901" required />
          </div>
          <div>
            <label className="label" htmlFor="newStudentName">이름</label>
            <input id="newStudentName" className="input" maxLength={80} value={newStudentName} onChange={(event) => setNewStudentName(event.target.value)} autoComplete="off" required />
          </div>
          <button className="button" disabled={busy || newStudentLoginId.length !== 5 || !newStudentName.trim()}>{busy ? "처리 중…" : "학생 추가"}</button>
        </form>
        <p className="notice-box student-account-note">추가 직후 표시되는 임시 비밀번호를 학생에게 직접 전달하세요. 비밀번호 원문은 다시 볼 수 없습니다.</p>
      </section>

      <section className="card card-body no-print">
        <h2 className="section-heading">학생 명단 Excel 등록</h2>
        <p className="section-subtitle">여러 명을 등록할 때 사용합니다. 열 제목은 원본과 같은 ‘반, 번호, 성명, 조 번호’를 사용하며 기존 학생의 비밀번호는 바뀌지 않습니다.</p>
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
              <button
                className="button ghost"
                type="button"
                disabled={busy || nextTeamNumber === null}
                title={nextTeamNumber === null ? "1조부터 20조까지 모두 사용 중입니다." : undefined}
                onClick={() => nextTeamNumber !== null && teamAction({ action: "create", classNumber, teamNumber: nextTeamNumber }, "새 팀을 만들었습니다.")}
              >
                {nextTeamNumber === null ? "팀 번호 모두 사용" : "+ 팀 추가"}
              </button>
              <button className="button secondary" type="button" onClick={() => setShowArchived((value) => !value)} aria-expanded={showArchived}>
                보관 팀 {visibleArchivedTeams.length}개
              </button>
              <button className="button secondary" type="button" onClick={() => setShowInactiveStudents((value) => !value)} aria-expanded={showInactiveStudents}>
                비활성 학생 {visibleInactiveStudents.length}명
              </button>
            </div>
          </div>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>학번</th><th>이름</th><th>현재 팀</th><th>팀장</th><th>계정</th><th>관리</th></tr></thead>
            <tbody>
              {visibleStudents.map((student) => (
                <Fragment key={student.id}>
                <tr>
                  <td>{student.loginId}</td>
                  <td><b>{student.name}</b></td>
                  <td>
                    <select
                      className="select"
                      value={student.teamId ?? ""}
                      disabled={busy}
                      onChange={(event) => event.target.value ? teamAction({ action: "assign", studentId: student.id, teamId: event.target.value }, "학생의 팀 배정을 변경했습니다.") : student.teamId && teamAction({ action: "remove", studentId: student.id, teamId: student.teamId }, "학생을 팀에서 제외했습니다.")}
                    >
                      <option value="">미배정</option>
                      {visibleTeams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
                    </select>
                  </td>
                  <td>{student.teamId ? <button className={`button ${student.isLeader ? "" : "secondary"}`} disabled={busy || student.isLeader} onClick={() => teamAction({ action: "leader", studentId: student.id, teamId: student.teamId }, "팀장을 지정했습니다.")}>{student.isLeader ? "팀장" : "지정"}</button> : "—"}</td>
                  <td><span className={`badge ${student.mustChangePassword ? "pending" : ""}`}>{student.mustChangePassword ? "첫 로그인 전" : "사용 중"}</span></td>
                  <td>
                    <div className="student-management-actions">
                      <button className="button ghost" disabled={busy} onClick={() => resetPassword(student.id)}>비밀번호 초기화</button>
                      <button className="button danger" type="button" disabled={busy} onClick={() => { setDeactivatingStudentId(student.id); setDeactivateConfirmation(""); }}>비활성화</button>
                    </div>
                  </td>
                </tr>
                {deactivatingStudentId === student.id ? (
                  <tr className="student-confirmation-row">
                    <td colSpan={6}>
                      <div className="archive-confirmation" role="group" aria-label="학생 계정 비활성화 확인">
                        <p>로그인과 현재 팀 접근을 중지하지만 과거 기록은 보존합니다. 계속하려면 학번 <b>{student.loginId}</b>을(를) 입력하세요.</p>
                        <label className="sr-only" htmlFor={`deactivate-${student.id}`}>비활성화 확인 학번</label>
                        <input id={`deactivate-${student.id}`} className="input" inputMode="numeric" autoComplete="off" value={deactivateConfirmation} onChange={(event) => setDeactivateConfirmation(event.target.value)} placeholder={student.loginId} />
                        <div className="toolbar-group">
                          <button className="button danger" type="button" disabled={busy || deactivateConfirmation.trim() !== student.loginId} onClick={() => changeStudentStatus("deactivate", student.id)}>계정 비활성화</button>
                          <button className="button secondary" type="button" disabled={busy} onClick={() => { setDeactivatingStudentId(null); setDeactivateConfirmation(""); }}>취소</button>
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : null}
                </Fragment>
              ))}
              {!visibleStudents.length ? <tr><td colSpan={6} className="empty-state">이 학급에 등록된 학생이 없습니다.</td></tr> : null}
            </tbody>
          </table>
        </div>
        {showInactiveStudents ? (
          <div className="card-body inactive-student-list" aria-label={`${classNumber}반 비활성 학생`}>
            <h3 className="section-heading">비활성 학생</h3>
            <p className="section-subtitle">과거 기록은 보존됩니다. 복원하면 로그인할 수 있지만 팀에는 자동으로 재배정되지 않습니다.</p>
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr><th>학번</th><th>이름</th><th>상태</th><th>관리</th></tr></thead>
                <tbody>
                  {visibleInactiveStudents.map((student) => (
                    <tr key={student.id}>
                      <td>{student.loginId}</td>
                      <td><b>{student.name}</b></td>
                      <td><span className="badge feedback">로그인 중지</span></td>
                      <td><button className="button secondary" type="button" disabled={busy} onClick={() => changeStudentStatus("restore", student.id)}>복원</button></td>
                    </tr>
                  ))}
                  {!visibleInactiveStudents.length ? <tr><td colSpan={4} className="empty-state">이 학급에 비활성 학생이 없습니다.</td></tr> : null}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
        <div className="card-body team-storage-section">
          <h3 className="section-heading">현재 팀 관리</h3>
          <div className="team-management-grid">
            {visibleTeams.map((team) => (
              <article className={`team-management-card ${archivingTeamId === team.id ? "confirming" : ""}`} key={team.id}>
                <div className="team-management-main">
                  <div><b>{team.name}</b><span>{team.memberCount}명 · {team.topic || "주제 탐색 중"}</span></div>
                  <button className="button ghost" type="button" disabled={busy} onClick={() => startArchive(team.id)}>보관</button>
                </div>
                {archivingTeamId === team.id ? (
                  <div className="archive-confirmation" role="group" aria-label={`${team.name} 보관 확인`}>
                    <p>학생 화면과 기본 목록에서 숨기되 과거 자료와 팀원 이력은 보존합니다. 계속하려면 <b>{team.classNumber}반 {team.name}</b>을(를) 입력하세요.</p>
                    <label className="sr-only" htmlFor={`archive-${team.id}`}>보관 확인 문구</label>
                    <input id={`archive-${team.id}`} className="input" value={archiveConfirmation} onChange={(event) => setArchiveConfirmation(event.target.value)} autoComplete="off" placeholder={`${team.classNumber}반 ${team.name}`} />
                    <div className="toolbar-group">
                      <button className="button danger" type="button" disabled={busy || archiveConfirmation.trim() !== `${team.classNumber}반 ${team.name}`} onClick={() => confirmArchive(team)}>팀 보관</button>
                      <button className="button secondary" type="button" disabled={busy} onClick={() => { setArchivingTeamId(null); setArchiveConfirmation(""); }}>취소</button>
                    </div>
                  </div>
                ) : null}
              </article>
            ))}
            {!visibleTeams.length ? <p className="section-subtitle">현재 팀이 없습니다.</p> : null}
          </div>
          {showArchived ? (
            <div className="archived-team-list" aria-label={`${classNumber}반 보관 팀`}>
              <h3 className="section-heading">보관된 팀</h3>
              <p className="section-subtitle">과거 자료와 팀원 이력은 유지됩니다. 복원하면 기본 목록과 학생 접근 조건에 다시 반영됩니다.</p>
              {visibleArchivedTeams.map((team) => (
                <article className="team-management-card archived" key={team.id}>
                  <div className="team-management-main">
                    <div><b>{team.name}</b><span>{team.memberCount}명 · {team.archivedByName ? `${team.archivedByName} 교사 보관` : "보관됨"}</span></div>
                    <button className="button secondary" type="button" disabled={busy} onClick={() => teamAction({ action: "restore", teamId: team.id }, `${team.classNumber}반 ${team.name}을(를) 복원했습니다.`)}>복원</button>
                  </div>
                </article>
              ))}
              {!visibleArchivedTeams.length ? <p className="empty-state">이 학급에 보관된 팀이 없습니다.</p> : null}
            </div>
          ) : null}
        </div>
      </section>

    </div>
  );
}
