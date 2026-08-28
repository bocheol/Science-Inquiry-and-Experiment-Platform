"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function PasswordForm() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const newPassword = String(data.get("newPassword") ?? "");
    const confirmPassword = String(data.get("confirmPassword") ?? "");
    if (newPassword !== confirmPassword) {
      setError("새 비밀번호가 서로 다릅니다.");
      return;
    }
    setLoading(true);
    setError("");
    const response = await fetch("/api/auth/change-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newPassword }),
    });
    const result = (await response.json()) as { message?: string; destination?: string };
    setLoading(false);
    if (!response.ok) return setError(result.message ?? "비밀번호를 변경하지 못했습니다.");
    router.replace(result.destination ?? "/");
    router.refresh();
  }

  return (
    <form onSubmit={submit}>
      <div className="field">
        <label htmlFor="newPassword">새 비밀번호</label>
        <input className="input" id="newPassword" name="newPassword" type="password" minLength={8} autoComplete="new-password" required />
        <small>8자 이상, 글자와 숫자를 함께 사용하세요.</small>
      </div>
      <div className="field">
        <label htmlFor="confirmPassword">새 비밀번호 확인</label>
        <input className="input" id="confirmPassword" name="confirmPassword" type="password" minLength={8} autoComplete="new-password" required />
      </div>
      {error ? <div className="error-box" role="alert">{error}</div> : null}
      <button className="button full" disabled={loading}>{loading ? "변경 중…" : "비밀번호 변경"}</button>
    </form>
  );
}

