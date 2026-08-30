"use client";

import { useEffect, useMemo, useState } from "react";
import type { ExamDifficulty, ExamManagementData, ExamPaper, ExamQuestion } from "@/lib/exam-service";
import { useToast } from "@/components/toast-provider";

const scopeText = { common: "전체 공통", team: "팀 공통", individual: "개인화" } as const;
const difficultyText = { basic: "기본", standard: "보통", advanced: "심화" } as const;

function paperQuestions(data: NonNullable<ExamManagementData["selected"]>, paper: ExamPaper) {
  const order = { common: 0, team: 1, individual: 2 };
  return data.questions
    .filter((question) => question.scope === "common"
      || (question.scope === "team" && question.teamId === paper.teamId)
      || (question.scope === "individual" && question.studentId === paper.studentId))
    .sort((left, right) => order[left.scope] - order[right.scope] || left.sequence - right.sequence);
}

function QuestionEditor({ question, disabled, onChanged }: { question: ExamQuestion; disabled: boolean; onChanged: () => Promise<void> }) {
  const { showToast } = useToast();
  const [stimulus, setStimulus] = useState(question.stimulus);
  const [prompt, setPrompt] = useState(question.question);
  const [competency, setCompetency] = useState(question.competency);
  const [difficulty, setDifficulty] = useState<ExamDifficulty>(question.difficulty);
  const [modelAnswer, setModelAnswer] = useState(question.modelAnswer);
  const [rubric, setRubric] = useState(question.scoringRubric.map((item) => `${item.criterion} | ${item.points}`).join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setStimulus(question.stimulus); setPrompt(question.question); setCompetency(question.competency);
    setDifficulty(question.difficulty); setModelAnswer(question.modelAnswer);
    setRubric(question.scoringRubric.map((item) => `${item.criterion} | ${item.points}`).join("\n"));
  }, [question]);

  async function save() {
    const scoringRubric = rubric.split("\n").map((line) => {
      const [criterion, points] = line.split("|");
      return { criterion: criterion?.trim() ?? "", points: Number(points?.trim() || 1) };
    }).filter((item) => item.criterion);
    setBusy(true); setError("");
    const response = await fetch("/api/teacher/exams", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ questionId: question.id, stimulus, question: prompt, competency, difficulty, modelAnswer, scoringRubric }),
    });
    const result = (await response.json()) as { message?: string };
    setBusy(false);
    if (!response.ok) {
      const text = result.message ?? "문항을 저장하지 못했습니다.";
      setError(text); showToast(text, "error"); return;
    }
    showToast("시험 문항을 저장했습니다.");
    await onChanged();
  }

  async function remove() {
    if (!window.confirm(`${scopeText[question.scope]} ${question.sequence}번 슬롯을 모든 해당 시험지에서 삭제할까요? 공정성을 위해 같은 범주의 같은 순번 문항이 함께 삭제됩니다.`)) return;
    setBusy(true); setError("");
    const response = await fetch(`/api/teacher/exams?questionId=${encodeURIComponent(question.id)}`, { method: "DELETE" });
    const result = (await response.json()) as { message?: string };
    setBusy(false);
    if (!response.ok) {
      const text = result.message ?? "문항을 삭제하지 못했습니다.";
      setError(text); showToast(text, "error"); return;
    }
    showToast("같은 범주의 문항 슬롯을 삭제했습니다.");
    await onChanged();
  }

  return (
    <article className="exam-question-card">
      <div className="toolbar">
        <div className="toolbar-group"><span className={`badge exam-${question.scope}`}>{scopeText[question.scope]}</span><b>{question.sequence}번 · {question.maxScore}점</b><span className="badge">{difficultyText[question.difficulty]}</span></div>
        <span className="save-state">{question.isAiGenerated ? "AI 생성" : "교사 추가"}</span>
      </div>
      <div className="field"><label>제시 자료</label><textarea className="textarea" value={stimulus} onChange={(event) => setStimulus(event.target.value)} disabled={disabled || busy} rows={4} /></div>
      <div className="field"><label>문제</label><textarea className="textarea" value={prompt} onChange={(event) => setPrompt(event.target.value)} disabled={disabled || busy} rows={3} /></div>
      <div className="grid two">
        <div className="field"><label>평가 역량</label><input className="input" value={competency} onChange={(event) => setCompetency(event.target.value)} disabled={disabled || busy} /></div>
        <div className="field"><label>난이도</label><select className="select" value={difficulty} onChange={(event) => setDifficulty(event.target.value as ExamDifficulty)} disabled={disabled || busy}><option value="basic">기본</option><option value="standard">보통</option><option value="advanced">심화</option></select></div>
      </div>
      <div className="field"><label>모범답안</label><textarea className="textarea" value={modelAnswer} onChange={(event) => setModelAnswer(event.target.value)} disabled={disabled || busy} rows={4} /></div>
      <div className="field"><label>채점 기준 <small>한 줄마다 기준 | 점수</small></label><textarea className="textarea" value={rubric} onChange={(event) => setRubric(event.target.value)} disabled={disabled || busy} rows={4} /></div>
      <details className="source-evidence"><summary>출제 근거 스냅샷</summary>{question.sourceEvidence.map((source, index) => <div key={`${source.sourceKey}-${index}`}><b>{source.sourceLabel}</b><p>{source.excerpt}</p></div>)}</details>
      {error ? <div className="error-box">{error}</div> : null}
      {!disabled ? <div className="toolbar-group"><button className="button" onClick={save} disabled={busy}>문항 저장</button><button className="button danger" onClick={remove} disabled={busy}>문항 슬롯 삭제</button></div> : null}
    </article>
  );
}

export function TeacherExamManager({ initialData }: { initialData: ExamManagementData }) {
  const { showToast } = useToast();
  const [data, setData] = useState(initialData);
  const [classNumber, setClassNumber] = useState(9);
  const [selectedExamId, setSelectedExamId] = useState(initialData.selected?.papers[0]?.examId ?? "");
  const [title, setTitle] = useState("2026학년도 통합과학 탐구 수행평가");
  const [commonCount, setCommonCount] = useState(4);
  const [teamCount, setTeamCount] = useState(2);
  const [individualCount, setIndividualCount] = useState(1);
  const [totalScore, setTotalScore] = useState(100);
  const [commonScope, setCommonScope] = useState("자료 해석, 변인 통제, 증거와 결론 연결, 오차 분석, 실험 개선");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [scores, setScores] = useState<Record<string, number>>({});
  const [feedback, setFeedback] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [newQuestion, setNewQuestion] = useState({ stimulus: "", question: "", competency: "탐구 설계", difficulty: "standard" as ExamDifficulty, maxScore: 5, modelAnswer: "", rubric: "핵심 근거를 들어 설명함 | 5" });

  const selected = data.selected;
  const selectedPaper = selected?.papers.find((paper) => paper.examId === selectedExamId) ?? selected?.papers[0] ?? null;
  const questions = useMemo(() => selected && selectedPaper ? paperQuestions(selected, selectedPaper) : [], [selected, selectedPaper]);

  useEffect(() => {
    if (!selectedPaper) return;
    setSelectedExamId(selectedPaper.examId);
    setScores(Object.fromEntries(questions.map((question) => [question.id, selectedPaper.result?.questionScores[question.id] ?? 0])));
    setFeedback(selectedPaper.result?.teacherFeedback ?? "");
  }, [selectedPaper?.examId, selectedPaper?.result?.gradedAt, questions.length]);

  async function load(nextClass = classNumber, setId?: string) {
    const query = new URLSearchParams({ classNumber: String(nextClass) });
    if (setId) query.set("setId", setId);
    const response = await fetch(`/api/teacher/exams?${query}`, { cache: "no-store" });
    if (!response.ok) return;
    const next = (await response.json()) as ExamManagementData;
    setData(next);
    setSelectedExamId(next.selected?.papers[0]?.examId ?? "");
  }

  async function generate(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    const response = await fetch("/api/teacher/exams", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "generate", classNumber, title, commonCount, teamCount, individualCount, totalScore, commonScope }),
    });
    const result = (await response.json()) as { message?: string; examSetId?: string };
    setBusy(false);
    if (!response.ok || !result.examSetId) {
      const text = result.message ?? "시험 문제를 생성하지 못했습니다.";
      setError(text); showToast(text, "error"); return;
    }
    setMessage("초안 생성이 끝났습니다. 학생별 문항과 출제 근거를 확인해 주세요.");
    showToast("시험 문제 초안을 생성했습니다.");
    await load(classNumber, result.examSetId);
  }

  async function post(body: Record<string, unknown>, success: string) {
    setBusy(true); setError(""); setMessage("");
    const response = await fetch("/api/teacher/exams", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = (await response.json()) as { message?: string };
    setBusy(false);
    if (!response.ok) {
      const text = result.message ?? "처리하지 못했습니다.";
      setError(text); showToast(text, "error"); return;
    }
    setMessage(success);
    showToast(success);
    await load(classNumber, selected?.id);
  }

  async function addCommon(event: React.FormEvent) {
    event.preventDefault();
    if (!selected) return;
    const scoringRubric = newQuestion.rubric.split("\n").map((line) => {
      const [criterion, points] = line.split("|"); return { criterion: criterion?.trim() ?? "", points: Number(points?.trim() || 1) };
    }).filter((item) => item.criterion);
    await post({ action: "addCommon", examSetId: selected.id, ...newQuestion, scoringRubric }, "공통 문항을 추가했습니다.");
    setShowAdd(false);
  }

  async function saveGrade() {
    if (!selectedPaper) return;
    await post({ action: "grade", examId: selectedPaper.examId, questionScores: scores, teacherFeedback: feedback }, "채점 결과를 저장했습니다.");
  }

  return (
    <div className="stack">
      {error ? <div className="error-box" role="alert">{error}</div> : null}
      {message ? <div className="notice-box">{message}</div> : null}

      <section className="card card-body no-print">
        <div className="toolbar"><div><h2 className="section-heading">새 시험 초안 생성</h2><p className="section-subtitle">AI 호출은 플랫폼 서버에서 실행되며 학생 실명·학번은 전송하지 않습니다.</p></div><span className="badge">기본 4 · 2 · 1</span></div>
        <form onSubmit={generate} className="stack compact-stack">
          <div className="grid two">
            <div className="field"><label htmlFor="examClass">학급</label><select id="examClass" className="select" value={classNumber} onChange={async (event) => { const value = Number(event.target.value); setClassNumber(value); await load(value); }}>{Array.from({ length: 9 }, (_, index) => index + 1).map((number) => <option value={number} key={number}>{number}반</option>)}</select></div>
            <div className="field"><label htmlFor="examTitle">시험 제목</label><input id="examTitle" className="input" value={title} onChange={(event) => setTitle(event.target.value)} /></div>
          </div>
          <div className="grid four exam-count-grid">
            <div className="field"><label>전체 공통</label><input className="input" type="number" min={0} max={5} value={commonCount} onChange={(event) => setCommonCount(Number(event.target.value))} /></div>
            <div className="field"><label>팀 공통</label><input className="input" type="number" min={0} max={5} value={teamCount} onChange={(event) => setTeamCount(Number(event.target.value))} /></div>
            <div className="field"><label>개인화</label><input className="input" type="number" min={0} max={3} value={individualCount} onChange={(event) => setIndividualCount(Number(event.target.value))} /></div>
            <div className="field"><label>총점</label><input className="input" type="number" min={1} max={200} value={totalScore} onChange={(event) => setTotalScore(Number(event.target.value))} /></div>
          </div>
          <div className="field"><label htmlFor="commonScope">공통 평가 범위</label><textarea id="commonScope" className="textarea" value={commonScope} onChange={(event) => setCommonScope(event.target.value)} rows={3} /></div>
          <div className="exam-fairness-note"><b>공정성 규칙</b><span>공통은 새 중립 자료 · 팀은 계획서/보고서 · 개인은 본인 일지/역할 · 같은 문제 틀과 채점 기준</span></div>
          <button className="button" disabled={busy}>{busy ? "자료를 분석해 문항 생성 중…" : "AI로 시험 초안 생성"}</button>
        </form>
      </section>

      <section className="card card-body no-print">
        <div className="toolbar"><div><h2 className="section-heading">생성된 시험</h2><p className="section-subtitle">학급별 이전 초안과 확정본을 선택할 수 있습니다.</p></div>{data.sets.length ? <select className="select" value={selected?.id ?? ""} onChange={(event) => load(classNumber, event.target.value)}>{data.sets.map((set) => <option value={set.id} key={set.id}>{set.title} · {set.status === "confirmed" ? "확정" : "초안"}</option>)}</select> : null}</div>
        {!data.sets.length ? <div className="empty-state">이 학급에 생성된 시험이 없습니다.</div> : null}
      </section>

      {selected ? (
        <>
          <section className="grid four metrics-grid">
            <article className="card metric"><span>상태</span><strong className="metric-text">{selected.status === "confirmed" ? "확정" : "초안"}</strong></article>
            <article className="card metric"><span>학생 시험지</span><strong>{selected.papers.length}</strong></article>
            <article className="card metric"><span>문항 구성</span><strong className="metric-text">{selected.commonCount}·{selected.teamCount}·{selected.individualCount}</strong></article>
            <article className="card metric"><span>총점</span><strong>{selected.totalScore}</strong></article>
          </section>

          <section className="card card-body">
            <div className="toolbar">
              <div><h2 className="section-heading">학생별 시험지 검토</h2><p className="section-subtitle">공통 수정은 학급 전체, 팀 수정은 해당 팀 전체, 개인 수정은 해당 학생에게 적용됩니다.</p></div>
              <div className="toolbar-group no-print">
                <select className="select" value={selectedPaper?.examId ?? ""} onChange={(event) => setSelectedExamId(event.target.value)}>{selected.papers.map((paper) => <option value={paper.examId} key={paper.examId}>{paper.teamName} · {paper.loginId} {paper.studentName}</option>)}</select>
                {selected.status === "confirmed" ? <><a className="button secondary" href={`/api/teacher/exams/pdf?examSetId=${selected.id}`}>학급 시험지 PDF</a><a className="button ghost" href={`/api/teacher/exams/pdf?examSetId=${selected.id}&answers=true`}>교사용 답안 PDF</a></> : null}
              </div>
            </div>
            {selectedPaper ? <div className="exam-paper-heading"><b>{selectedPaper.classNumber}반 {selectedPaper.teamName} · {selectedPaper.studentName}</b><span>총 {questions.reduce((sum, question) => sum + question.maxScore, 0)}점</span></div> : null}
            <div className="stack">{questions.map((question) => <QuestionEditor key={question.id} question={question} disabled={selected.status === "confirmed"} onChanged={() => load(classNumber, selected.id)} />)}</div>
            {selected.status === "draft" ? (
              <div className="stack no-print" style={{ marginTop: 18 }}>
                <div className="toolbar-group"><button className="button secondary" onClick={() => setShowAdd((value) => !value)}>+ 공통 문항 직접 추가</button><button className="button" disabled={busy} onClick={() => window.confirm("문항·근거·채점 기준을 모두 검토했나요? 확정 후에는 수정할 수 없습니다.") && post({ action: "confirm", examSetId: selected.id }, "시험을 확정했습니다. 이제 PDF로 출력할 수 있습니다.")}>검토 완료·시험 확정</button></div>
                {showAdd ? <form className="exam-question-card" onSubmit={addCommon}><h3>공통 문항 직접 추가</h3><div className="field"><label>제시 자료</label><textarea className="textarea" value={newQuestion.stimulus} onChange={(event) => setNewQuestion({ ...newQuestion, stimulus: event.target.value })} /></div><div className="field"><label>문제</label><textarea className="textarea" required value={newQuestion.question} onChange={(event) => setNewQuestion({ ...newQuestion, question: event.target.value })} /></div><div className="grid two"><div className="field"><label>평가 역량</label><input className="input" required value={newQuestion.competency} onChange={(event) => setNewQuestion({ ...newQuestion, competency: event.target.value })} /></div><div className="field"><label>배점</label><input className="input" type="number" min={1} max={100} value={newQuestion.maxScore} onChange={(event) => setNewQuestion({ ...newQuestion, maxScore: Number(event.target.value) })} /></div></div><div className="field"><label>모범답안</label><textarea className="textarea" required value={newQuestion.modelAnswer} onChange={(event) => setNewQuestion({ ...newQuestion, modelAnswer: event.target.value })} /></div><div className="field"><label>채점 기준</label><textarea className="textarea" value={newQuestion.rubric} onChange={(event) => setNewQuestion({ ...newQuestion, rubric: event.target.value })} /></div><button className="button">추가</button></form> : null}
              </div>
            ) : null}
          </section>

          {selected.status === "confirmed" && selectedPaper ? (
            <section className="card card-body no-print">
              <div className="toolbar"><div><h2 className="section-heading">수동 채점·결과 공개</h2><p className="section-subtitle">종이 답안을 채점한 뒤 학생별 점수와 피드백을 저장합니다.</p></div><span className={`badge ${selectedPaper.status === "published" ? "" : "pending"}`}>{selectedPaper.status === "published" ? "학생 공개됨" : selectedPaper.status === "graded" ? "채점 저장됨" : "채점 전"}</span></div>
              <div className="grading-grid">{questions.map((question, index) => <label key={question.id}><span>{index + 1}번</span><input className="input" type="number" min={0} max={question.maxScore} value={scores[question.id] ?? 0} onChange={(event) => setScores({ ...scores, [question.id]: Number(event.target.value) })} /><small>/ {question.maxScore}</small></label>)}</div>
              <div className="field"><label>학생에게 공개할 교사 피드백</label><textarea className="textarea" value={feedback} onChange={(event) => setFeedback(event.target.value)} rows={4} /></div>
              <div className="toolbar-group"><button className="button" disabled={busy} onClick={saveGrade}>채점 저장</button><button className="button secondary" disabled={busy || !selectedPaper.result?.gradedAt} onClick={() => window.confirm("이 학생에게 점수와 피드백을 공개할까요?") && post({ action: "publish", examId: selectedPaper.examId }, "학생에게 결과를 공개했습니다.")}>결과 공개</button></div>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
