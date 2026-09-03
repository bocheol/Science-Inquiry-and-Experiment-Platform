"use client";

import { useEffect, useState } from "react";
import { useToast } from "@/components/toast-provider";
import {
  canShowPushAction,
  disablePush,
  enablePush,
  getBlockedPushInstructions,
  getPushActionLabel,
  inspectAndSyncPush,
  refreshPushState,
  type PushClientState,
} from "@/lib/push-client";

function getIOSState() {
  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigatorWithStandalone.standalone === true;
  return { ios, needsInstall: ios && !standalone };
}

export function PushSubscriptionSync() {
  useEffect(() => {
    void inspectAndSyncPush().catch(() => undefined);
  }, []);
  return null;
}

export function PushNotificationManager() {
  const { showToast } = useToast();
  const [state, setState] = useState<PushClientState>("checking");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [isIOS, setIsIOS] = useState(false);
  const [iosNeedsInstall, setIosNeedsInstall] = useState(false);

  useEffect(() => {
    const iosState = getIOSState();
    setIsIOS(iosState.ios);
    setIosNeedsInstall(iosState.needsInstall);
    let active = true;

    const updateState = (forceRefresh: boolean) => {
      void (forceRefresh ? refreshPushState() : inspectAndSyncPush())
      .then((next) => {
        if (!active) return;
        setState(next);
        if (next !== "blocked") setError("");
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setState("disabled");
        setError(cause instanceof Error ? cause.message : "기기 알림 상태를 확인하지 못했습니다.");
      });
    };

    updateState(false);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") updateState(true);
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  async function changeEnabled() {
    setBusy(true);
    setError("");
    try {
      const next = state === "enabled" ? await disablePush() : await enablePush();
      setState(next);
      if (next === "enabled") showToast("이 기기에서 과탐실 푸시 알림을 받습니다.");
      else if (next === "disabled") showToast("이 기기의 과탐실 푸시 알림을 껐습니다.");
      else if (next === "blocked") {
        const message = getBlockedPushInstructions(isIOS);
        showToast(message);
      }
    } catch (cause) {
      const blocked = Notification.permission === "denied";
      const message = blocked
        ? getBlockedPushInstructions(isIOS)
        : cause instanceof Error ? cause.message : "기기 알림 설정을 바꾸지 못했습니다.";
      if (blocked) setState("blocked");
      setError(blocked ? "" : message);
      showToast(message, blocked ? "info" : "error");
    } finally {
      setBusy(false);
    }
  }

  const descriptions: Record<PushClientState, string> = {
    checking: "이 기기의 알림 상태를 확인하고 있습니다.",
    unsupported: "이 브라우저에서는 웹 푸시 알림을 사용할 수 없습니다.",
    unconfigured: "서버의 푸시 알림 준비가 아직 완료되지 않았습니다.",
    blocked: "브라우저 또는 기기 설정에서 이 앱의 알림이 차단되어 있습니다.",
    disabled: "푸시를 켜면 앱을 닫아도 새 공지와 수정 요청 도착을 알 수 있습니다.",
    enabled: "새 공지와 계획서·보고서 수정 요청을 이 기기로 알려드립니다.",
  };

  return (
    <section className="card card-body push-notification-card" aria-labelledby="push-notification-title">
      <div className="push-notification-heading">
        <div>
          <h2 className="section-heading" id="push-notification-title">기기 푸시 알림</h2>
          <p className="section-subtitle">{descriptions[state]}</p>
        </div>
        <span className={`badge ${state === "enabled" ? "" : "pending"}`}>{state === "enabled" ? "켜짐" : "꺼짐"}</span>
      </div>
      <p className="push-privacy-note">잠금 화면에는 공지 내용이나 학생 정보가 표시되지 않습니다. 알림을 누르면 로그인 후 공지·알림함에서 내용을 확인합니다.</p>
      {iosNeedsInstall ? <div className="notice-box">iPhone·iPad는 Safari의 공유 버튼에서 <b>홈 화면에 추가</b>한 뒤, 설치된 앱을 열어 푸시를 켜세요.</div> : null}
      {state === "blocked" ? <div className="warning-box">{getBlockedPushInstructions(isIOS)}</div> : null}
      {error ? <div className="error-box" role="alert">{error}</div> : null}
      {canShowPushAction(state, iosNeedsInstall) ? (
        <button className={`button ${state === "enabled" ? "secondary" : ""}`} type="button" disabled={busy} onClick={() => void changeEnabled()}>
          {busy ? "처리 중…" : getPushActionLabel(state)}
        </button>
      ) : null}
    </section>
  );
}
