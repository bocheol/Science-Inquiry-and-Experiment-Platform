"use client";

import { useState } from "react";
import type { ManagedAccount, MasterAccountData, OneTimeCredential } from "@/lib/master-accounts";
import { useToast } from "@/components/toast-provider";

function AccountList({ accounts, busy, onAction }: {
  accounts: ManagedAccount[];
  busy: boolean;
  onAction: (action: "deactivate" | "restore" | "resetPassword", account: ManagedAccount) => Promise<void>;
}) {
  return <div className="table-wrap"><table className="data-table"><thead><tr><th>이름·아이디</th><th>구분</th><th>상태</th><th>비밀번호</th><th>관리</th></tr></thead><tbody>
    {accounts.map((account) => <tr key={account.id}>
      <td><b>{account.name}</b><br /><small>{account.loginId}</small></td>
      <td>{account.isMaster ? <span className="badge approved">마스터</span> : account.accountType === "demo" ? <span className="badge">체험 학생</span> : "교사"}</td>
      <td><span className={`badge ${account.status === "active" ? "approved" : "pending"}`}>{account.status === "active" ? "활성" : "비활성"}</span></td>
      <td>{account.mustChangePassword ? "첫 로그인 변경 필요" : "변경 완료"}</td>
      <td><div className="toolbar-group">
        {!account.isMaster ? account.status === "active"
          ? <button className="button ghost" disabled={busy} onClick={() => onAction("deactivate", account)}>비활성화</button>
          : <button className="button secondary" disabled={busy} onClick={() => onAction("restore", account)}>복원</button> : null}
        {!account.isMaster ? <button className="button secondary" disabled={busy} onClick={() => onAction("resetPassword", account)}>임시 비밀번호 발급</button> : null}
      </div></td>
    </tr>)}
  </tbody></table></div>;
}

export function MasterAccountManager({ initialData }: { initialData: MasterAccountData }) {
  const [data, setData] = useState(initialData);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [credential, setCredential] = useState<OneTimeCredential | null>(null);
  const { showToast } = useToast();

  async function refresh() {
    const response = await fetch("/api/teacher/master/accounts", { cache: "no-store" });
    const result = await response.json() as MasterAccountData & { message?: string };
    if (!response.ok) throw new Error(result.message ?? "계정 목록을 불러오지 못했습니다.");
    setData(result);
  }

  async function create(event: React.FormEvent<HTMLFormElement>, kind: "teacher" | "demo") {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(true); setError(""); setCredential(null);
    try {
      const response = await fetch("/api/teacher/master/accounts", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "create", kind, name: values.get("name"), loginId: values.get("loginId") }),
      });
      const result = await response.json() as { message?: string; credential?: OneTimeCredential };
      if (!response.ok || !result.credential) throw new Error(result.message ?? "계정을 만들지 못했습니다.");
      setCredential(result.credential); form.reset(); await refresh(); showToast("계정을 만들었습니다.");
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : "계정을 만들지 못했습니다.";
      setError(text); showToast(text, "error");
    } finally { setBusy(false); }
  }

  async function change(action: "deactivate" | "restore" | "resetPassword", account: ManagedAccount) {
    const label = action === "deactivate" ? "비활성화" : action === "restore" ? "복원" : "임시 비밀번호 발급";
    if (!window.confirm(`${account.name} (${account.loginId}) 계정을 ${label}할까요?`)) return;
    setBusy(true); setError(""); setCredential(null);
    try {
      const response = await fetch("/api/teacher/master/accounts", {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, accountId: account.id }),
      });
      const result = await response.json() as { message?: string; credential?: OneTimeCredential };
      if (!response.ok) throw new Error(result.message ?? "계정을 변경하지 못했습니다.");
      if (result.credential) setCredential(result.credential);
      await refresh(); showToast(`계정을 ${label}했습니다.`);
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : "계정을 변경하지 못했습니다.";
      setError(text); showToast(text, "error");
    } finally { setBusy(false); }
  }

  return <div className="stack">
    {error ? <div className="error-box" role="alert">{error}</div> : null}
    {credential ? <section className="notice-box one-time-credential" role="status"><b>한 번만 표시되는 임시 로그인 정보</b><p>아이디: <strong>{credential.loginId}</strong></p><p>임시 비밀번호: <strong>{credential.temporaryPassword}</strong></p><p>본인에게 직접 전달해 주세요. 첫 로그인에서 새 비밀번호로 변경됩니다.</p><button className="button secondary" onClick={() => setCredential(null)}>확인하고 닫기</button></section> : null}
    <section className="grid two">
      <form className="card card-body stack" onSubmit={(event) => create(event, "teacher")}>
        <div><h2 className="section-heading">새 교사 계정</h2><p className="section-subtitle">교사마다 개인 아이디를 사용합니다.</p></div>
        <label className="field"><span>교사 이름</span><input className="input" name="name" required maxLength={80} /></label>
        <label className="field"><span>로그인 아이디</span><input className="input" name="loginId" required minLength={3} maxLength={40} autoCapitalize="none" /></label>
        <button className="button" disabled={busy}>교사 계정 만들기</button>
      </form>
      <form className="card card-body stack" onSubmit={(event) => create(event, "demo")}>
        <div><h2 className="section-heading">교사용 학생 체험 계정</h2><p className="section-subtitle">실제 학생과 구분되며 공식 통계·평가·시험·시트 전송에서 제외됩니다.</p></div>
        <label className="field"><span>표시 이름</span><input className="input" name="name" required maxLength={80} /></label>
        <label className="field"><span>체험 아이디 <small>demo-로 시작</small></span><input className="input" name="loginId" required minLength={6} maxLength={40} placeholder="demo-science1" autoCapitalize="none" /></label>
        <button className="button" disabled={busy}>체험 계정 만들기</button>
      </form>
    </section>
    <section className="card card-body stack"><div><h2 className="section-heading">교사 계정</h2><p className="section-subtitle">계정은 삭제하지 않고 비활성화·복원합니다.</p></div><AccountList accounts={data.teachers} busy={busy} onAction={change} /></section>
    <section className="card card-body stack"><div><h2 className="section-heading">체험 학생 계정</h2><p className="section-subtitle">체험 활동이 필요하면 동아리에서 이 아이디를 학생으로 추가해 배정할 수 있습니다.</p></div>{data.demoStudents.length ? <AccountList accounts={data.demoStudents} busy={busy} onAction={change} /> : <div className="empty-state">아직 체험 학생 계정이 없습니다.</div>}</section>
  </div>;
}
