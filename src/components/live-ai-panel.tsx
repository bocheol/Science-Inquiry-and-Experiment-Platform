"use client";

import { useEffect, useRef, useState } from "react";

type Line = { id: number; role: "student" | "assistant"; text: string };
const IDLE_MS = 60_000;

export function LiveAiPanel({ sessionId, cycleId, available }: { sessionId: string; cycleId?: string; available: boolean }) {
  const peer = useRef<RTCPeerConnection | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const channel = useRef<RTCDataChannel | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lineId = useRef(0);
  const [state, setState] = useState<"idle" | "connecting" | "listening">("idle");
  const [message, setMessage] = useState("");
  const [lines, setLines] = useState<Line[]>([]);

  function clearIdle() {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = null;
  }

  function close(reason?: string) {
    clearIdle();
    const currentChannel = channel.current; channel.current = null; currentChannel?.close();
    const currentPeer = peer.current; peer.current = null; currentPeer?.close();
    stream.current?.getTracks().forEach(track => track.stop()); stream.current = null;
    if (audio.current) audio.current.srcObject = null;
    setState("idle");
    if (reason) setMessage(reason);
  }

  function waitForStudent() {
    clearIdle();
    idleTimer.current = setTimeout(() => close("60초 동안 새 발화가 없어 Live AI를 종료했습니다."), IDLE_MS);
  }

  function append(role: Line["role"], text: unknown) {
    if (typeof text !== "string" || !text.trim()) return;
    const next = { id: ++lineId.current, role, text: text.trim() };
    setLines(current => [...current.slice(-18), next]);
  }

  function onRealtimeEvent(event: MessageEvent<string>) {
    try {
      const data = JSON.parse(event.data) as { type?: string; transcript?: string; error?: { message?: string } };
      if (data.type === "input_audio_buffer.speech_started") { clearIdle(); setMessage("학생 발화를 듣고 있습니다…"); }
      else if (data.type === "input_audio_buffer.speech_stopped") setMessage("답변을 준비하고 있습니다…");
      else if (data.type === "conversation.item.input_audio_transcription.completed") append("student", data.transcript);
      else if (data.type === "response.output_audio_transcript.done") append("assistant", data.transcript);
      else if (data.type === "response.done") { setMessage("듣는 중입니다."); waitForStudent(); }
      else if (data.type === "error") close(data.error?.message || "Live AI 연결에 오류가 발생했습니다.");
    } catch { /* Ignore unknown Realtime events and keep the audio session alive. */ }
  }

  async function start() {
    if (!available || !cycleId || state !== "idle") return;
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
      setMessage("이 브라우저에서는 Live AI 음성 연결을 지원하지 않습니다.");
      return;
    }
    setState("connecting"); setMessage("마이크와 Live AI를 연결하는 중…"); setLines([]);
    try {
      const tokenResponse = await fetch("/api/inquiry/live-ai/session", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, cycleId }),
      });
      const token = await tokenResponse.json() as { clientSecret?: string; message?: string };
      if (!tokenResponse.ok || !token.clientSecret) throw new Error(token.message ?? "Live AI를 시작하지 못했습니다.");

      const localStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      stream.current = localStream;
      const pc = new RTCPeerConnection(); peer.current = pc;
      pc.ontrack = event => {
        if (audio.current) {
          audio.current.srcObject = event.streams[0] ?? new MediaStream([event.track]);
          void audio.current.play().catch(() => setMessage("기기 음소거를 해제하고 화면을 한 번 눌러 주세요."));
        }
      };
      pc.onconnectionstatechange = () => {
        if (["failed", "disconnected", "closed"].includes(pc.connectionState) && peer.current === pc) close("Live AI 연결이 종료되었습니다.");
      };
      for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
      const dc = pc.createDataChannel("oai-events"); channel.current = dc;
      dc.onmessage = onRealtimeEvent;
      dc.onopen = () => { setState("listening"); setMessage("연결됐습니다. 질문을 말해 주세요."); waitForStudent(); };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const sdpResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        headers: { Authorization: `Bearer ${token.clientSecret}`, "Content-Type": "application/sdp" },
        body: offer.sdp,
      });
      if (!sdpResponse.ok) throw new Error("Live AI 음성 연결을 만들지 못했습니다.");
      await pc.setRemoteDescription({ type: "answer", sdp: await sdpResponse.text() });
    } catch (error) {
      close(error instanceof Error ? error.message : "Live AI를 시작하지 못했습니다.");
    }
  }

  useEffect(() => () => close(), []);

  return <section className="live-ai-panel stack" aria-label="실험 Live AI">
    <div><h2 className="section-heading">실험 Live AI</h2><p className="section-subtitle">실험 중 짧게 묻고 음성으로 답을 듣는 별도 대화입니다.</p></div>
    <p className="notice-box">최신 팀 계획서·보고서·교사 피드백·팀 공동 활동 정리만 참고합니다. 개인 일지는 전혀 전송하지 않습니다.</p>
    {!available ? <p className="empty-state">계획 승인과 실험 준비가 끝난 현재 회차에서 사용할 수 있습니다.</p> : <>
      <div className="toolbar-group">
        {state === "idle"
          ? <button className="button" type="button" onClick={() => void start()}>🎙 Live AI 시작</button>
          : <button className="button danger" type="button" onClick={() => close("사용자가 Live AI를 종료했습니다.")}>■ Live AI 종료</button>}
        <span role="status">{message}</span>
      </div>
      <small>평소 답변은 1~3문장입니다. 학생의 말이 끝날 때까지 기다리며, 60초 동안 새 발화가 없으면 자동 종료합니다. 현재 자막과 음성은 일지나 팀 기록으로 저장하지 않습니다.</small>
      <audio ref={audio} autoPlay aria-label="Live AI 음성 답변" />
      {lines.length ? <div className="live-ai-transcript" aria-label="현재 Live AI 대화 자막">{lines.map(line => <p key={line.id}><b>{line.role === "student" ? "학생" : "Live AI"}</b> {line.text}</p>)}</div> : null}
    </>}
  </section>;
}
