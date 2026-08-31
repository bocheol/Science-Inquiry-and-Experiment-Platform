"use client";

import { useCallback, useEffect, useState } from "react";
import type { NoticeFeed } from "@/lib/notices";

export function AppHeader({ name, role }: { name: string; role: "student" | "teacher" }) {
  const [feed, setFeed] = useState<NoticeFeed | null>(null);
  const [popupDismissed, setPopupDismissed] = useState(false);

  const refreshNotices = useCallback(async () => {
    if (role !== "student") return;
    const response = await fetch("/api/notices", { cache: "no-store" });
    if (!response.ok) return;
    const result = (await response.json()) as { feed?: NoticeFeed };
    if (result.feed) setFeed(result.feed);
  }, [role]);

  useEffect(() => {
    if (role !== "student") return;
    if (window.location.pathname === "/notices") setPopupDismissed(true);
    void refreshNotices();
    const changed = () => void refreshNotices();
    const timer = window.setInterval(changed, 30_000);
    window.addEventListener("notice-feed-changed", changed);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("notice-feed-changed", changed);
    };
  }, [refreshNotices, role]);

  async function acknowledgePopup() {
    const notice = feed?.popupNotice;
    if (!notice) return false;
    const response = await fetch("/api/notices", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ noticeId: notice.id }),
    });
    if (!response.ok) return false;
    setPopupDismissed(true);
    await refreshNotices();
    window.dispatchEvent(new Event("notice-feed-changed"));
    return true;
  }

  async function acknowledgeAndGo(path: string) {
    if (await acknowledgePopup()) window.location.assign(path);
  }

  return (
    <>
      <header className="app-header no-print">
        <a className="brand" href={role === "teacher" ? "/teacher" : "/inquiry"}>
          <span className="brand-mark">🔬</span>
          <span>과탐실</span>
        </a>
        <div className="user-chip">
          {role === "student" ? <a className="header-notice-link" href="/notices">공지·알림{feed?.unreadCount ? <span className="notice-count" aria-label={`읽지 않은 공지 ${feed.unreadCount}개`}>{feed.unreadCount > 99 ? "99+" : feed.unreadCount}</span> : null}</a> : <a className="header-notice-link" href="/teacher/notices">공지 관리</a>}
          <span>{name} · {role === "teacher" ? "교사" : "학생"}</span>
          <form action="/api/auth/logout" method="post">
            <button className="button secondary" type="submit">로그아웃</button>
          </form>
        </div>
      </header>
      {role === "student" && feed?.popupNotice && !popupDismissed ? (
        <div className="notice-popup-backdrop no-print" role="presentation">
          <section className="notice-popup" role="dialog" aria-modal="true" aria-labelledby="important-notice-title">
            <div className="toolbar"><span className="badge feedback">중요 공지</span><span className="save-state">미확인 중요 공지 {feed.unreadImportantCount}개</span></div>
            <h2 id="important-notice-title">{feed.popupNotice.title}</h2>
            <p>{feed.popupNotice.content}</p>
            {feed.popupNotice.calendarStart ? <p className="notice-schedule">📅 {feed.popupNotice.calendarStart}{feed.popupNotice.calendarEnd && feed.popupNotice.calendarEnd !== feed.popupNotice.calendarStart ? ` ~ ${feed.popupNotice.calendarEnd}` : ""}</p> : null}
            <div className="toolbar-group">
              {feed.popupNotice.actionPath ? <button className="button" type="button" autoFocus onClick={() => void acknowledgeAndGo(feed.popupNotice!.actionPath!)}>확인하고 처리하기</button> : <button className="button" type="button" autoFocus onClick={() => void acknowledgePopup()}>확인했습니다</button>}
              <a className="button secondary" href="/notices">알림함에서 모두 보기</a>
              <button className="button ghost" type="button" onClick={() => setPopupDismissed(true)}>나중에</button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
