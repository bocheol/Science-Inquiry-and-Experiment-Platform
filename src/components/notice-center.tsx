"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PushNotificationManager } from "@/components/push-notification-manager";
import { useToast } from "@/components/toast-provider";
import type { NoticeFeed, NoticeItem } from "@/lib/notices";

type Filter = "all" | "unread" | "action";

function seoulDate(value: string) {
  const date = new Date(new Date(value).getTime() + 9 * 60 * 60 * 1000);
  return `${date.getUTCFullYear()}. ${date.getUTCMonth() + 1}. ${date.getUTCDate()}. ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

function dateLabel(start: string | null, end: string | null) {
  if (!start) return null;
  return end && end !== start ? `${start} ~ ${end}` : start;
}

function dateKey(year: number, month: number, day: number) {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function Calendar({ notices, onSelect }: { notices: NoticeItem[]; onSelect: (notice: NoticeItem) => void }) {
  const today = new Date();
  const [month, setMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const blankDays = new Date(year, monthIndex, 1).getDay();
  const dayCount = new Date(year, monthIndex + 1, 0).getDate();
  const cells = [...Array.from({ length: blankDays }, () => null), ...Array.from({ length: dayCount }, (_, index) => index + 1)];

  function eventsFor(day: number) {
    const key = dateKey(year, monthIndex, day);
    return notices.filter((notice) => notice.calendarStart && notice.calendarStart <= key && (notice.calendarEnd ?? notice.calendarStart) >= key);
  }

  return (
    <section className="notice-calendar" aria-label="공지 일정 달력">
      <div className="calendar-toolbar">
        <button className="button ghost" type="button" aria-label="이전 달" onClick={() => setMonth(new Date(year, monthIndex - 1, 1))}>‹</button>
        <h2>{year}년 {monthIndex + 1}월</h2>
        <button className="button ghost" type="button" aria-label="다음 달" onClick={() => setMonth(new Date(year, monthIndex + 1, 1))}>›</button>
      </div>
      <div className="calendar-grid calendar-weekdays" aria-hidden="true">
        {["일", "월", "화", "수", "목", "금", "토"].map((day) => <span key={day}>{day}</span>)}
      </div>
      <div className="calendar-grid">
        {cells.map((day, index) => day === null ? <span className="calendar-day empty" key={`empty-${index}`} /> : (
          <div className={`calendar-day ${dateKey(year, monthIndex, day) === dateKey(today.getFullYear(), today.getMonth(), today.getDate()) ? "today" : ""}`} key={day}>
            <span className="calendar-day-number">{day}</span>
            <div className="calendar-events">
              {eventsFor(day).slice(0, 3).map((notice) => (
                <button className={`calendar-event ${notice.priority === "important" ? "important" : ""}`} type="button" key={notice.id} onClick={() => onSelect(notice)}>{notice.title}</button>
              ))}
              {eventsFor(day).length > 3 ? <small>+{eventsFor(day).length - 3}개</small> : null}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function NoticeCenter({ initialFeed }: { initialFeed: NoticeFeed }) {
  const { showToast } = useToast();
  const [feed, setFeed] = useState(initialFeed);
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/notices", { cache: "no-store" });
    const result = (await response.json()) as { feed?: NoticeFeed; message?: string };
    if (!response.ok || !result.feed) throw new Error(result.message ?? "공지·알림을 불러오지 못했습니다.");
    setFeed(result.feed);
  }, []);

  useEffect(() => {
    const changed = () => void refresh();
    window.addEventListener("notice-feed-changed", changed);
    return () => window.removeEventListener("notice-feed-changed", changed);
  }, [refresh]);

  const visible = useMemo(() => feed.notices.filter((notice) => {
    if (filter === "unread") return !notice.isRead;
    if (filter === "action") return notice.kind === "action_request";
    return true;
  }), [feed.notices, filter]);
  const scheduled = useMemo(() => feed.notices.filter((notice) => notice.calendarStart), [feed.notices]);

  async function openNotice(notice: NoticeItem) {
    setSelectedId(notice.id);
    if (notice.isRead) return;
    setBusyId(notice.id);
    const response = await fetch("/api/notices", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ noticeId: notice.id }),
    });
    setBusyId(null);
    if (!response.ok) {
      const result = (await response.json()) as { message?: string };
      showToast(result.message ?? "공지 확인 상태를 저장하지 못했습니다.", "error");
      return;
    }
    await refresh();
    window.dispatchEvent(new Event("notice-feed-changed"));
  }

  return (
    <div className="stack notice-center">
      <PushNotificationManager />
      <section className="notice-summary-grid">
        <button className={`summary-card ${filter === "unread" ? "selected" : ""}`} type="button" onClick={() => setFilter("unread")}><span>읽지 않은 공지</span><strong>{feed.unreadCount}</strong></button>
        <button className={`summary-card ${filter === "action" ? "selected" : ""}`} type="button" onClick={() => setFilter("action")}><span>처리 필요</span><strong>{feed.actionRequiredCount}</strong></button>
        <button className={`summary-card ${filter === "all" ? "selected" : ""}`} type="button" onClick={() => setFilter("all")}><span>전체 알림</span><strong>{feed.notices.length}</strong></button>
      </section>
      <Calendar notices={scheduled} onSelect={(notice) => void openNotice(notice)} />
      <section className="card card-body">
        <div className="toolbar">
          <div><h2 className="section-heading">공지·알림함</h2><p className="section-subtitle">공지와 수정 요청을 한곳에서 확인합니다. 읽음과 처리 완료는 별도로 표시됩니다.</p></div>
          <div className="notice-filter-group" role="group" aria-label="공지 필터">
            <button className={`button ${filter === "all" ? "" : "secondary"}`} type="button" onClick={() => setFilter("all")}>전체</button>
            <button className={`button ${filter === "unread" ? "" : "secondary"}`} type="button" onClick={() => setFilter("unread")}>안 읽음</button>
            <button className={`button ${filter === "action" ? "" : "secondary"}`} type="button" onClick={() => setFilter("action")}>처리 요청</button>
          </div>
        </div>
        <div className="notice-list">
          {visible.map((notice) => {
            const expanded = selectedId === notice.id;
            return (
              <article className={`notice-card ${!notice.isRead ? "unread" : ""} ${notice.kind === "action_request" && !notice.isResolved ? "action-required" : ""}`} key={notice.id}>
                <button className="notice-card-summary" type="button" aria-expanded={expanded} onClick={() => void openNotice(notice)} disabled={busyId === notice.id}>
                  <span className="notice-card-title">
                    {!notice.isRead ? <span className="unread-dot" aria-label="읽지 않음" /> : null}
                    <b>{notice.title}</b>
                    {notice.priority === "important" ? <span className="badge feedback">중요</span> : null}
                    {notice.kind === "action_request" ? <span className={`badge ${notice.isResolved ? "" : "pending"}`}>{notice.isResolved ? "처리 완료" : "처리 필요"}</span> : null}
                  </span>
                  <span className="notice-meta">{notice.targetLabel} · {seoulDate(notice.createdAt)}</span>
                </button>
                {expanded ? (
                  <div className="notice-card-content">
                    <p>{notice.content}</p>
                    {dateLabel(notice.calendarStart, notice.calendarEnd) ? <p className="notice-schedule">📅 {dateLabel(notice.calendarStart, notice.calendarEnd)}</p> : null}
                    {notice.actionPath ? <a className="button" href={notice.actionPath}>{notice.isResolved ? "관련 내용 보기" : "확인하고 처리하기"}</a> : null}
                    {notice.authorName ? <small>{notice.authorName} 교사</small> : null}
                  </div>
                ) : null}
              </article>
            );
          })}
          {!visible.length ? <p className="empty-state">해당하는 공지·알림이 없습니다.</p> : null}
        </div>
      </section>
    </div>
  );
}
