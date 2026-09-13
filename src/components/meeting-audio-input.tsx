"use client";

import { useEffect, useRef, useState } from "react";

const MAX_RECORDING_MS = 5 * 60 * 1000;

function preferredMimeType() {
  if (typeof MediaRecorder === "undefined") return "";
  return ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find(type => MediaRecorder.isTypeSupported(type)) ?? "";
}

export function MeetingAudioInput({ sessionId, cycleId, value, onChange, disabled }: {
  sessionId: string;
  cycleId?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [message, setMessage] = useState("");

  function release() {
    if (stopTimer.current) clearTimeout(stopTimer.current);
    stopTimer.current = null;
    stream.current?.getTracks().forEach(track => track.stop());
    stream.current = null;
    recorder.current = null;
    setRecording(false);
  }

  useEffect(() => () => {
    if (recorder.current) recorder.current.onstop = null;
    if (recorder.current?.state === "recording") recorder.current.stop();
    release();
  }, []);

  async function transcribe(blob: Blob) {
    if (!cycleId) { setMessage("현재 탐구 회차를 확인해 주세요."); return; }
    if (!blob.size) { setMessage("녹음된 말소리가 없습니다."); return; }
    setTranscribing(true);
    setMessage("녹음을 글로 바꾸는 중…");
    try {
      const data = new FormData();
      data.set("sessionId", sessionId);
      data.set("cycleId", cycleId);
      const extension = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
      data.set("audio", blob, `meeting-recording.${extension}`);
      const response = await fetch("/api/discussions/transcribe", { method: "POST", body: data });
      const result = await response.json() as { text?: string; message?: string };
      if (!response.ok || !result.text) throw new Error(result.message ?? "음성을 글로 바꾸지 못했습니다.");
      const next = [value.trim(), result.text.trim()].filter(Boolean).join("\n\n").slice(0, 16000);
      onChange(next);
      setMessage("전사문을 입력칸에 넣었습니다. 내용을 확인하고 수정한 뒤 저장해 주세요.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "음성을 글로 바꾸지 못했습니다.");
    } finally {
      setTranscribing(false);
    }
  }

  async function start() {
    if (disabled || recording || transcribing) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setMessage("이 브라우저에서는 음성 녹음을 지원하지 않습니다.");
      return;
    }
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const mimeType = preferredMimeType();
      const nextRecorder = new MediaRecorder(media, mimeType ? { mimeType } : undefined);
      stream.current = media;
      recorder.current = nextRecorder;
      chunks.current = [];
      nextRecorder.ondataavailable = event => { if (event.data.size) chunks.current.push(event.data); };
      nextRecorder.onerror = () => { nextRecorder.onstop = null; setMessage("녹음 중 오류가 발생했습니다."); release(); };
      nextRecorder.onstop = () => {
        const blob = new Blob(chunks.current, { type: nextRecorder.mimeType || "audio/webm" });
        chunks.current = [];
        release();
        void transcribe(blob);
      };
      nextRecorder.start(1000);
      setRecording(true);
      setMessage("녹음 중입니다. 끝나면 녹음 마침을 누르세요.");
      stopTimer.current = setTimeout(() => {
        if (nextRecorder.state === "recording") nextRecorder.stop();
      }, MAX_RECORDING_MS);
    } catch {
      release();
      setMessage("마이크 사용을 허용해야 녹음할 수 있습니다.");
    }
  }

  function stop() {
    if (recorder.current?.state === "recording") recorder.current.stop();
  }

  return <div className="meeting-audio-input stack">
    <div className="toolbar-group">
      {!recording
        ? <button type="button" className="button secondary" disabled={disabled || transcribing || !cycleId} onClick={() => void start()}>🎙 음성으로 메모</button>
        : <button type="button" className="button danger" onClick={stop}>■ 녹음 마침</button>}
      {transcribing ? <span role="status">전사 중…</span> : null}
    </div>
    <small>녹음 파일은 전사에만 사용하고 보관하지 않습니다. 전사문을 확인·수정한 뒤 기존 방식으로 저장합니다.</small>
    {message ? <p className="section-subtitle" role="status">{message}</p> : null}
  </div>;
}
