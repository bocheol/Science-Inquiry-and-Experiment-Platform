"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/toast-provider";

export function LoginForm() {
  const router = useRouter();
  const { showToast } = useToast();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);
    const data = new FormData(event.currentTarget);
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        loginId: data.get("loginId"),
        password: data.get("password"),
      }),
    });
    const result = (await response.json()) as { ok?: boolean; message?: string; destination?: string };
    setLoading(false);
    if (!response.ok) {
      const text = result.message ?? "로그인할 수 없습니다.";
      setError(text);
      showToast(text, "error");
      return;
    }
    showToast("로그인되었습니다.");
    router.replace(result.destination ?? "/");
    router.refresh();
  }

  return (
    <form onSubmit={submit}>
      <div className="field">
        <label htmlFor="loginId">학번 또는 교사 아이디</label>
        <input className="input" id="loginId" name="loginId" autoComplete="username" placeholder="예: 10901" required />
      </div>
      <div className="field">
        <label htmlFor="password">비밀번호</label>
        <input className="input" id="password" name="password" type="password" autoComplete="current-password" required />
      </div>
      {error ? <div className="error-box" role="alert">{error}</div> : null}
      <button className="button full" type="submit" disabled={loading}>
        {loading ? "확인하고 있어요…" : "로그인"}
      </button>
      {process.env.NODE_ENV !== "production" ? (
        <div className="notice-box">
          로컬 데모: 교사 <b>teacher / teacher1234</b>, 학생 <b>10901 / student1234</b>
        </div>
      ) : null}
    </form>
  );
}
