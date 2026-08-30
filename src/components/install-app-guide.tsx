"use client";

import { useEffect, useState } from "react";

type InstallOutcome = "accepted" | "dismissed";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: InstallOutcome }>;
}

function isRunningAsApp() {
  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia("(display-mode: standalone)").matches || navigatorWithStandalone.standalone === true;
}

export function InstallAppGuide() {
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    setInstalled(isRunningAsApp());

    function handleBeforeInstallPrompt(event: Event) {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    }

    function handleInstalled() {
      setInstalled(true);
      setInstallPrompt(null);
      setMessage("설치가 완료되었습니다. 이제 홈 화면이나 바탕 화면에서 바로 열 수 있어요.");
    }

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleInstalled);
    };
  }, []);

  async function install() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    setInstallPrompt(null);
    setMessage(choice.outcome === "accepted" ? "설치를 진행하고 있어요." : "필요할 때 기기별 설치 방법을 다시 확인하세요.");
  }

  if (installed) return null;

  return (
    <section className="install-app-guide" aria-labelledby="install-app-title">
      <div className="install-app-heading">
        <span className="install-app-icon" aria-hidden="true">📲</span>
        <div>
          <h3 id="install-app-title">앱처럼 바로 열기</h3>
          <p>설치하면 홈 화면이나 바탕 화면에서 이 주소로 바로 접속합니다.</p>
        </div>
      </div>

      {installPrompt ? (
        <button className="button full" type="button" onClick={install}>
          이 기기에 앱 설치
        </button>
      ) : null}

      <details className="install-device-help" open={!installPrompt}>
        <summary>기기별 설치 방법</summary>
        <ul>
          <li><b>iPhone·iPad</b>: Safari의 공유 버튼 → 홈 화면에 추가 → 웹 앱으로 열기</li>
          <li><b>Android</b>: Chrome 메뉴(⋮) → 앱 설치 또는 홈 화면에 추가</li>
          <li><b>PC·Mac</b>: Chrome·Edge 주소창의 설치 아이콘 또는 메뉴 → 앱 설치</li>
        </ul>
      </details>

      <p className="install-privacy">오프라인 사용을 위한 학생 자료 저장은 하지 않습니다.</p>
      {message ? <p className="install-feedback" role="status">{message}</p> : null}
    </section>
  );
}
