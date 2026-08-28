"use client";

export function AppHeader({ name, role }: { name: string; role: "student" | "teacher" }) {
  return (
    <header className="app-header no-print">
      <a className="brand" href={role === "teacher" ? "/teacher" : "/inquiry"}>
        <span className="brand-mark">🔬</span>
        <span>과탐실</span>
      </a>
      <div className="user-chip">
        <span>{name} · {role === "teacher" ? "교사" : "학생"}</span>
        <form action="/api/auth/logout" method="post">
          <button className="button secondary" type="submit">로그아웃</button>
        </form>
      </div>
    </header>
  );
}

