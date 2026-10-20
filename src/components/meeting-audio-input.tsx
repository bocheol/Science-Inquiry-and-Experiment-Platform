"use client";

import { useEffect, useRef, useState } from "react";

const MAX_RECORDING_MS = 5 * 60 * 1000;

function preferredMimeType() {
  if (typeof MediaRecorder === "undefined") return "";
  return ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find(type => MediaRecorder.isTypeSupported(type)) ?? "";
}

export function MeetingAudioInput({ sessionId, cycleId, currentUserId, value, onChange, disabled }: {
  sessionId: string;
  currentUserId: string;
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
  const [transcript, setTranscript] = useState("");
  const alive = useRef(true);
  const request = useRef<AbortController | null>(null);
  const context = `${currentUserId}:${sessionId}:${cycleId}`;
  const contextRef = useRef(context);
  contextRef.current = context;

  function release() {
    if (stopTimer.current) clearTimeout(stopTimer.current);
    stopTimer.current = null;
    stream.current?.getTracks().forEach(track => track.stop());
    stream.current = null;
    recorder.current = null;
    setRecording(false);
  }

  useEffect(() => { alive.current = true; setTranscript(""); setTranscribing(false); setMessage(""); return () => {
    alive.current = false; request.current?.abort();
    if (recorder.current) recorder.current.onstop = null;
    if (recorder.current?.state === "recording") recorder.current.stop();
    release();
  }; }, [context]);

  async function transcribe(blob: Blob) {
    if (!cycleId) { setMessage("현재 탐구 회차를 확인해 주세요."); return; }
    if (!blob.size) { setMessage("녹음된 말소리가 없습니다."); return; }
    const startedIn = context;
    request.current = new AbortController();
    setTranscribing(true);
    setMessage("녹음을 글로 바꾸는 중…");
    try {
      const data = new FormData();
      data.set("sessionId", sessionId);
      data.set("cycleId", cycleId);
      const extension = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
      data.set("audio", blob, `meeting-recording.${extension}`);
      const response = await fetch("/api/discussions/transcribe", { method: "POST", body: data, headers: { "x-expected-user-id": currentUserId }, signal: request.current.signal });
      const result = await response.json() as { text?: string; message?: string };
      if (!response.ok || !result.text) throw new Error(result.message ?? "음성을 글로 바꾸지 못했습니다.");
      if (!alive.current || contextRef.current !== startedIn) return;
      setTranscript(result.text);
      setMessage("전사문이 준비되었습니다. 확인한 뒤 현재 메모에 덧붙여 주세요.");
    } catch (error) {
      if (!alive.current || contextRef.current !== startedIn) return;
      setMessage(error instanceof Error ? error.message : "음성을 글로 바꾸지 못했습니다.");
    } finally {
      if (alive.current && contextRef.current === startedIn) setTranscribing(false);
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
      if (!alive.current || contextRef.current !== context) { media.getTracks().forEach(track => track.stop()); return; }
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
    {transcript ? <div className="stack"><label htmlFor="meeting-transcript">전사문 확인</label><textarea id="meeting-transcript" className="textarea" value={transcript} onChange={event => setTranscript(event.target.value)} /><button type="button" className="button secondary" disabled={disabled || [value, transcript].filter(Boolean).join("\n\n").length > 16000} onClick={() => { onChange([value, transcript].filter(Boolean).join("\n\n")); setTranscript(""); setMessage("현재 메모 뒤에 전사문을 덧붙였습니다. 확인 후 저장해 주세요."); }}>현재 메모에 덧붙이기</button>{[value, transcript].filter(Boolean).join("\n\n").length > 16000 ? <p role="alert">합계가 16,000자를 넘습니다. 전사문을 나누거나 줄여 주세요. 원문은 자동으로 자르지 않습니다.</p> : null}</div> : null}
    {message ? <p className="section-subtitle" role="status">{message}</p> : null}
  </div>;
}
