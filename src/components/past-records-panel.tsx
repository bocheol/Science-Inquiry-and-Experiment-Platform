"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PastRecordDay, PastRecordDetail, PastRecordFilter } from "@/lib/past-records";

const filterLabels: Record<PastRecordFilter, string> = { all: "전체", conversation: "대화", journal: "일지" };
const kindLabels: Record<PastRecordDetail["conversations"][number]["kind"], string> = {
  ai_question: "AI에게 한 질문", ai_answer: "AI 답변", peer: "우리끼리 대화", meeting: "대면 기록", supplement: "보완 기록",
};

function dayLabel(date: string) {
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric", weekday: "short" })
    .format(new Date(`${date}T00:00:00+09:00`));
}

function timeLabel(value: string) {
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function keyOf(day: Pick<PastRecordDay, "teamId" | "cycleId" | "date">) {
  return `${day.teamId}:${day.cycleId}:${day.date}`;
}

function RecordDetail({ data, audience }: { data: PastRecordDetail; audience: "student" | "teacher" }) {
  return <div className="past-record-detail stack compact">
    {data.conversations.length ? <section><h4>대화와 활동 기록</h4><div className="stack compact">{data.conversations.map((item) => <article className="past-conversation" key={item.id}>
      <div className="toolbar"><strong>{kindLabels[item.kind]}</strong><small>{item.authorName} · {timeLabel(item.createdAt)}</small></div>
      <p>{item.content}</p>
    </article>)}</div></section> : null}
    {data.journals.length ? <section><h4>{audience === "student" ? "내 개인 일지" : "개인 일지"}</h4><div className="stack compact">{data.journals.map((journal) => <article className="journal-read-card" key={journal.id}>
      <div className="toolbar"><h4>{journal.sessionNumber}차시 일지</h4>{journal.studentName ? <strong>{journal.studentName}</strong> : null}</div>
      <dl><dt>오늘 한 일</dt><dd>{journal.activities || "작성 없음"}</dd><dt>관찰 결과</dt><dd>{journal.observations || "작성 없음"}</dd><dt>느낀 점 / 궁금한 점</dt><dd>{journal.reflections || "작성 없음"}</dd></dl>
    </article>)}</div></section> : null}
    {!data.conversations.length && !data.journals.length ? <div className="empty-state">이 날짜의 기록을 찾지 못했습니다.</div> : null}
  </div>;
}

export function PastRecordsPanel({ audience, teamId }: { audience: "student" | "teacher"; teamId?: string }) {
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PastRecordFilter>("all");
  const [days, setDays] = useState<PastRecordDay[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [details, setDetails] = useState<Record<string, PastRecordDetail>>({});
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({});
  const requestSequence = useRef(0);

  const load = useCallback(async (nextOffset = 0, append = false, signal?: AbortSignal) => {
    const sequence = ++requestSequence.current;
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams({ mode: "list", q: query.trim(), type: filter, offset: String(nextOffset) });
      if (teamId) params.set("teamId", teamId);
      const response = await fetch(`/api/past-records?${params}`, { cache: "no-store", signal });
      const result = await response.json() as { days?: PastRecordDay[]; hasMore?: boolean; message?: string };
      if (!response.ok) throw new Error(result.message ?? "지난 기록을 불러오지 못했습니다.");
      if (sequence !== requestSequence.current || signal?.aborted) return;
      setDays((current) => append ? [...current, ...(result.days ?? [])] : result.days ?? []);
      setOffset(nextOffset + (result.days?.length ?? 0));
      setHasMore(Boolean(result.hasMore));
    } catch (caught) {
      if (!signal?.aborted && sequence === requestSequence.current) setError(caught instanceof Error ? caught.message : "지난 기록을 불러오지 못했습니다.");
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [filter, query, teamId]);

  useEffect(() => {
    if (!opened) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(0, false, controller.signal), 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [opened, load]);

  async function loadDetail(day: PastRecordDay) {
    const key = keyOf(day);
    if (details[key]) return;
    setDetailErrors((current) => ({ ...current, [key]: "" }));
    const params = new URLSearchParams({ mode: "detail", teamId: day.teamId, cycleId: day.cycleId, date: day.date });
    try {
      const response = await fetch(`/api/past-records?${params}`, { cache: "no-store" });
      const result = await response.json() as PastRecordDetail & { message?: string };
      if (!response.ok) throw new Error(result.message ?? "이 날짜의 기록을 열지 못했습니다.");
      setDetails((current) => ({ ...current, [key]: result }));
    } catch (caught) {
      setDetailErrors((current) => ({ ...current, [key]: caught instanceof Error ? caught.message : "이 날짜의 기록을 열지 못했습니다." }));
    }
  }

  return <details className="card past-records-panel" onToggle={(event) => setOpened(event.currentTarget.open)}>
    <summary><span><strong>지난 기록 보기</strong><small>대화와 개인 일지를 날짜별로 찾아봅니다.</small></span><span aria-hidden="true">⌄</span></summary>
    {opened ? <div className="past-records-content stack compact">
      <label className="label" htmlFor={`past-record-search-${audience}-${teamId ?? "all"}`}>기록 검색
        <input id={`past-record-search-${audience}-${teamId ?? "all"}`} className="input" type="search" value={query} maxLength={100} onChange={(event) => setQuery(event.target.value)} placeholder="제목이나 본문을 검색하세요" />
      </label>
      <div className="past-record-filters" role="group" aria-label="지난 기록 종류">{(Object.keys(filterLabels) as PastRecordFilter[]).map((value) => <button type="button" key={value} className={`button ${filter === value ? "" : "secondary"}`} aria-pressed={filter === value} onClick={() => setFilter(value)}>{filterLabels[value]}</button>)}</div>
      {error ? <div className="error-box" role="alert">{error}</div> : null}
      {!loading && !error && days.length === 0 ? <div className="empty-state">{query.trim() ? "검색어와 일치하는 지난 기록이 없습니다." : "아직 볼 수 있는 대화나 일지가 없습니다."}</div> : null}
      <div className="past-record-list">{days.map((day) => {
        const key = keyOf(day);
        return <details className="past-record-day" key={key} onToggle={(event) => { if (event.currentTarget.open) void loadDetail(day); }}>
          <summary>
            <span className="past-record-date">{dayLabel(day.date)}</span>
            <span className="past-record-context">{day.activityName} · {day.teamName} · {day.cycleTitle}{day.cycleStatus !== "active" ? " · 완료 회차" : ""}</span>
            <span className="toolbar-group">{day.conversationCount ? <span className="badge">대화 {day.conversationCount}</span> : null}{day.journalCount ? <span className="badge approved">일지 {day.journalCount}</span> : null}</span>
            <strong>{day.representativeTitle}</strong><span className="past-record-preview">{day.representativeText}</span>
          </summary>
          {detailErrors[key] ? <div className="error-box">{detailErrors[key]}</div> : details[key] ? <RecordDetail data={details[key]} audience={audience} /> : <div className="empty-state">이 날짜의 기록을 불러오는 중입니다…</div>}
        </details>;
      })}</div>
      {loading ? <p className="past-record-loading" role="status">지난 기록을 불러오는 중입니다…</p> : null}
      {hasMore && !loading ? <button className="button secondary" type="button" onClick={() => void load(offset, true)}>더 보기</button> : null}
    </div> : null}
  </details>;
}
