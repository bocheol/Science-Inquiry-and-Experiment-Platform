export type PushClientState = "checking" | "unsupported" | "unconfigured" | "blocked" | "disabled" | "enabled";

type PushConfig = { configured?: boolean; publicKey?: string; message?: string };
let inspectionPromise: Promise<PushClientState> | null = null;

function base64UrlToBytes(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

function isSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

async function getConfig() {
  const response = await fetch("/api/push-subscriptions", { cache: "no-store" });
  const result = (await response.json()) as PushConfig;
  if (!response.ok) throw new Error(result.message ?? "기기 알림 설정을 확인하지 못했습니다.");
  return result;
}

async function registerWorker() {
  return navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
}

async function saveSubscription(subscription: PushSubscription) {
  const response = await fetch("/api/push-subscriptions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(subscription.toJSON()),
  });
  const result = (await response.json()) as { message?: string };
  if (!response.ok) throw new Error(result.message ?? "기기 알림 정보를 저장하지 못했습니다.");
}

async function inspectAndSyncPushOnce(): Promise<PushClientState> {
  if (!isSupported()) return "unsupported";
  const config = await getConfig();
  if (!config.configured || !config.publicKey) return "unconfigured";
  const registration = await registerWorker();
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    await saveSubscription(subscription);
    return "enabled";
  }
  return Notification.permission === "denied" ? "blocked" : "disabled";
}

export function inspectAndSyncPush(): Promise<PushClientState> {
  inspectionPromise ??= inspectAndSyncPushOnce().catch((error: unknown) => {
    inspectionPromise = null;
    throw error;
  });
  return inspectionPromise;
}

export function refreshPushState(): Promise<PushClientState> {
  inspectionPromise = null;
  return inspectAndSyncPush();
}

export function canShowPushAction(state: PushClientState, iosNeedsInstall: boolean) {
  return !iosNeedsInstall && (state === "enabled" || state === "disabled" || state === "blocked");
}

export function getPushActionLabel(state: PushClientState) {
  if (state === "enabled") return "이 기기 알림 끄기";
  if (state === "blocked") return "알림 다시 켜기";
  return "이 기기 알림 켜기";
}

export function getBlockedPushInstructions(isIOS: boolean) {
  if (isIOS) {
    return "iPhone·iPad의 설정 → 알림 → 과탐실 AI에서 알림 허용을 켠 뒤, 앱으로 돌아와 알림 다시 켜기를 눌러 주세요.";
  }
  return "브라우저의 사이트 설정 또는 기기 설정 → 알림에서 과탐실 AI 알림을 허용한 뒤, 앱으로 돌아와 알림 다시 켜기를 눌러 주세요.";
}

export async function enablePush(): Promise<PushClientState> {
  if (!isSupported()) return "unsupported";
  const config = await getConfig();
  if (!config.configured || !config.publicKey) return "unconfigured";
  if (Notification.permission === "denied") {
    inspectionPromise = Promise.resolve("blocked");
    return "blocked";
  }
  const registration = await registerWorker();
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing ?? await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToBytes(config.publicKey),
  });
  await saveSubscription(subscription);
  inspectionPromise = Promise.resolve("enabled");
  return "enabled";
}

export async function disablePush(): Promise<PushClientState> {
  if (!isSupported()) return "unsupported";
  const registration = await navigator.serviceWorker.getRegistration("/");
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) {
    inspectionPromise = Promise.resolve("disabled");
    return "disabled";
  }
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  const response = await fetch("/api/push-subscriptions", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
  if (!response.ok) {
    const result = (await response.json()) as { message?: string };
    throw new Error(result.message ?? "기기 알림 해제 상태를 저장하지 못했습니다.");
  }
  inspectionPromise = Promise.resolve("disabled");
  return "disabled";
}
