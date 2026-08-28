"use client";

import { useEffect, useState } from "react";

type PublishedExam = {
  title: string;
  totalScore: number;
  maxScore: number;
  teacherFeedback: string;
  publishedAt: string;
  questions: Array<{
    sequence: number;
    scope: "common" | "team" | "individual";
    question: string;
    score: number;
    maxScore: number;
  }>;
};

const scopeLabel = { common: "전체 공통", team: "팀 공통", individual: "개인화" } as const;

export function ExamResultPanel() {
  const [data, setData] = useState<PublishedExam | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void fetch("/api/inquiry/exam", { cache: "no-store" })
      .then(async (response) => {
        const result = (await response.json()) as { data?: PublishedExam | null; message?: string };
        if (!response.ok) throw new Error(result.message ?? "시험 결과를 불러오지 못했습니다.");
        if (active) setData(result.data ?? null);
      })
      .catch((cause: unknown) => active && setError(cause instanceof Error ? cause.message : "시험 결과를 불러오지 못했습니다."))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []);

  if (loading) return <div className="empty-state">시험 결과를 확인하고 있어요.</div>;
  if (error) return <div className="error-box">{error}</div>;
  if (!data) {
    return (
      <div className="empty-state">
        <h2>아직 공개된 시험 결과가 없어요</h2>
        <p>시험지는 수업 시간에 배부되며, 채점이 끝나고 선생님이 공개하면 이곳에서 결과를 확인할 수 있습니다.</p>
      </div>
    );
  }

  return (
    <div className="stack exam-result-panel">
      <div className="page-title exam-result-heading">
        <div><span className="eyebrow">시험 결과</span><h1>{data.title}</h1><p>{new Date(data.publishedAt).toLocaleDateString("ko-KR")} 공개</p></div>
        <div className="exam-total"><strong>{data.totalScore}</strong><span>/ {data.maxScore}점</span></div>
      </div>
      <div className="exam-result-list">
        {data.questions.map((question) => (
          <article className="exam-result-item" key={`${question.scope}-${question.sequence}`}>
            <div className="toolbar">
              <span className={`badge exam-${question.scope}`}>{scopeLabel[question.scope]}</span>
              <strong>{question.score} / {question.maxScore}점</strong>
            </div>
            <p><b>{question.sequence}.</b> {question.question}</p>
          </article>
        ))}
      </div>
      <section className="feedback-box"><h2>선생님 피드백</h2><p>{data.teacherFeedback || "별도 피드백이 없습니다."}</p></section>
    </div>
  );
}
