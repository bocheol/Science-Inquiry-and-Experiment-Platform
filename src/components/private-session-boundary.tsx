"use client";
import { useEffect, useState } from "react";
import { currentSessionMarker, hidePrivateScreen, lockPrivateSession, preservePrivateDrafts, showPrivateScreen } from "@/lib/private-session";
import { retryJournalRecoveries, sealLegacyJournalDrafts } from "@/lib/journal-recovery-client";

export function PrivateSessionBoundary({ ownerId, marker, children }: { ownerId: string | null; marker: string | null; children: React.ReactNode }) {
  const [verified, setVerified] = useState(!ownerId);
  const [locked, setLocked] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!ownerId) { showPrivateScreen(); return; }
    let active = true; let validatedOnce = false; let checking = false; let invalidated = false; let lastCheckAt = 0;
    const mismatch = () => Boolean(marker && currentSessionMarker() !== marker);
    const invalidate = () => {
      if (invalidated || !active) return;
      invalidated = true; hidePrivateScreen();
      // Snapshot dirty fields before unmount, then remove the old DOM immediately.
      void lockPrivateSession(); setLocked(true); setVerified(false);
    };
    const verify = async () => {
      if (!active || invalidated || checking) return;
      if (mismatch()) { invalidate(); return; }
      checking = true; lastCheckAt = Date.now();
      try {
        const response = await fetch("/api/auth/identity", { cache: "no-store", signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error("로그인을 확인하지 못했습니다.");
        const identity = await response.json();
        if (!active || invalidated) return;
        if (identity.userId !== ownerId || (marker && identity.sessionMarker !== marker)) { invalidate(); return; }
        let storageWarning = "";
        await sealLegacyJournalDrafts(ownerId).catch(() => { storageWarning = "기기 복구 저장소를 사용할 수 없습니다. 서버 저장 상태를 확인해 주세요."; });
        if (!active || invalidated) return;
        if (mismatch()) { invalidate(); return; }
        validatedOnce = true; setVerified(true); setMessage(storageWarning); showPrivateScreen(); retryJournalRecoveries();
      } catch {
        if (!active || invalidated) return;
        // Existing verified owner can keep working offline; a changed login marker cannot.
        if (validatedOnce && marker && !mismatch()) showPrivateScreen();
        else { hidePrivateScreen(); setMessage("로그인과 기기 복구 저장소를 확인하지 못했습니다. 연결·저장 공간을 확인한 뒤 다시 열어 주세요."); }
      } finally { checking = false; }
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") { hidePrivateScreen(); void preservePrivateDrafts().catch(() => undefined); }
      else { hidePrivateScreen(); void verify(); }
    };
    const pageHide = () => { hidePrivateScreen(); void preservePrivateDrafts().catch(() => undefined); };
    const pageShow = () => { hidePrivateScreen(); void verify(); };
    const storage = (event: StorageEvent) => { if (event.key === "science-private-session-change") invalidate(); };
    const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("science-private-session") : null;
    if (channel) channel.onmessage = invalidate;
    window.addEventListener("storage", storage); window.addEventListener("pagehide", pageHide); window.addEventListener("pageshow", pageShow);
    document.addEventListener("visibilitychange", visibility); window.addEventListener("online", pageShow);
    const interval = setInterval(() => { if (document.visibilityState === "visible") { if (mismatch()) invalidate(); else if (Date.now() - lastCheckAt >= 30_000) void verify(); } }, 1000);
    hidePrivateScreen(); void verify();
    return () => { active = false; clearInterval(interval); channel?.close(); window.removeEventListener("storage", storage); window.removeEventListener("pagehide", pageHide); window.removeEventListener("pageshow", pageShow); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("online", pageShow); };
  }, [ownerId, marker]);
  if (locked) return <main className="page-shell"><p>로그인이 변경되어 이전 화면을 잠갔습니다. 미전송 일지 사본은 작성한 계정으로 다시 로그인하면 확인할 수 있습니다.</p><a href="/login" className="button">로그인 화면으로</a></main>;
  return <>{verified && message ? <div className="warning-box" role="alert">{message}</div> : null}{!verified ? <main className="page-shell"><p role="status">{message || "로그인과 복구 저장소를 확인하는 중…"}</p>{message ? <button className="button" onClick={() => window.location.reload()}>다시 확인</button> : null}</main> : null}<div data-private-screen hidden={!verified}>{children}</div></>;
}
