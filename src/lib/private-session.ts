import { flushJournalRecoveries, lockJournalRecoveries } from "@/lib/journal-recovery-client";

const flushers = new Set<() => Promise<void>>();
let logoutReady = false;
export function privateLogoutReady() { return logoutReady; }
export function markPrivateLogoutReady() { logoutReady = true; }
export function registerPrivateDraftFlusher(flusher: () => Promise<void>) { flushers.add(flusher); return () => { flushers.delete(flusher); }; }
export function hidePrivateScreen() { document.documentElement.dataset.privateLocked = "true"; }
export function showPrivateScreen() { delete document.documentElement.dataset.privateLocked; }
export async function preservePrivateDrafts() {
  const results = await Promise.allSettled([...flushers].map(flush => flush()));
  if (results.some(result => result.status === "rejected")) throw new Error("작성 내용의 복구 저장에 실패했습니다. 연결이나 저장 공간을 확인한 뒤 로그아웃해 주세요.");
  // Each flusher already falls back to the server if its local write failed.
  void flushJournalRecoveries();
}
export function announcePrivateSessionChange() {
  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("science-private-session") : null;
  channel?.postMessage("changed"); channel?.close();
  try { localStorage.setItem("science-private-session-change", crypto.randomUUID()); } catch { /* BroadcastChannel and marker checks remain. */ }
}
export async function lockPrivateSession() {
  hidePrivateScreen();
  await preservePrivateDrafts().catch(() => undefined);
  lockJournalRecoveries();
  window.dispatchEvent(new Event("science-private-session-locked"));
}
/** This is a non-secret login marker, never an authentication token. */
export function currentSessionMarker() {
  return document.cookie.split(";").map(part => part.trim()).find(part => part.startsWith("science-session-marker="))?.slice("science-session-marker=".length) ?? null;
}
