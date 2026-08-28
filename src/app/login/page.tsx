import { redirect } from "next/navigation";
import { LoginForm } from "@/components/login-form";
import { getCurrentUser } from "@/lib/auth";

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect(user.mustChangePassword ? "/change-password" : user.role === "teacher" ? "/teacher" : "/inquiry");
  return (
    <main className="auth-shell">
      <section className="auth-hero">
        <span className="eyebrow">🔬 2026 통합과학 · 팀 탐구</span>
        <div>
          <h1>질문에서 시작하는<br />우리의 과학 탐구</h1>
          <p>AI는 답을 대신 쓰지 않습니다. 팀이 좋은 질문을 만들고, 검증 가능한 탐구로 발전시키도록 한 단계씩 돕습니다.</p>
        </div>
        <small>상당고등학교 과학과제연구</small>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          <h2>탐구실 입장</h2>
          <p>교사에게 받은 아이디와 비밀번호를 입력하세요.</p>
          <LoginForm />
        </div>
      </section>
    </main>
  );
}

