import { redirect } from "next/navigation";
import { PasswordForm } from "@/components/password-form";
import { getCurrentUser } from "@/lib/auth";

export default async function ChangePasswordPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return (
    <main className="auth-shell">
      <section className="auth-hero">
        <span className="eyebrow">🔐 첫 로그인 보안 설정</span>
        <div>
          <h1>나만의 비밀번호로<br />바꿔 주세요</h1>
          <p>임시 비밀번호는 다시 표시되지 않습니다. 잊어버리면 선생님이 새 임시 비밀번호를 발급할 수 있습니다.</p>
        </div>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          <h2>{user.name} 님</h2>
          <p>수업에서 계속 사용할 비밀번호를 정해 주세요.</p>
          <PasswordForm />
        </div>
      </section>
    </main>
  );
}

