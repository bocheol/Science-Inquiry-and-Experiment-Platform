// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { JournalPanel } from "@/components/journal-panel";
import { MeetingAudioInput } from "@/components/meeting-audio-input";

const fake = vi.hoisted(() => ({ put: vi.fn(), remove: vi.fn(), toast: vi.fn() }));
vi.mock("@/components/toast-provider", () => ({ useToast: () => ({ showToast: fake.toast }) }));
vi.mock("@/lib/journal-drafts", () => ({ putJournalDraft: fake.put, deleteJournalDraft: fake.remove, prepareJournalPhoto: vi.fn() }));
vi.mock("@/lib/journal-recovery-client", () => ({ initializeJournalRecovery: vi.fn(), listJournalRecoveryDrafts: vi.fn(async () => []), restoreJournalRecoveryDraft: vi.fn(), watchJournalRecovery: () => () => {}, flushJournalRecoveries: vi.fn(), isCurrentJournalDraftDurable: () => false, lockJournalRecoveries: vi.fn() }));

beforeEach(() => { fake.put.mockReset().mockResolvedValue(undefined); fake.remove.mockReset().mockResolvedValue(undefined); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("saves a partially written journal to the server even when local storage fails", async () => {
  fake.put.mockRejectedValue(new Error("synthetic storage unavailable"));
  let posted: FormData | undefined;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit = {}) => {
    if (init.method !== "POST") return Response.json({ journals: [] });
    posted = init.body as FormData;
    return Response.json({ journal: { id: "saved", sessionNumber: 1, date: "2026-10-20", activities: "", observations: "측정값 하나만 입력", reflections: "", version: 1, images: [] } });
  }));
  render(React.createElement(JournalPanel, { sessionId: "s", cycleId: "c", currentUserId: "owner" }));
  fireEvent.change(await screen.findByLabelText("관찰 결과"), { target: { value: "측정값 하나만 입력" } });
  fireEvent.click(screen.getByRole("button", { name: /임시 저장/ }));
  await waitFor(() => expect(posted).toBeDefined());
  expect(posted!.get("observations")).toBe("측정값 하나만 입력");
  expect(posted!.get("activities")).toBe("");
  expect(await screen.findByText("1차시 일지를 저장했습니다.")).toBeTruthy();
});

it("keeps additional typing while the server save is in flight", async () => {
  let complete!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit = {}) => init.method === "POST" ? new Promise<Response>(resolve => { complete = resolve; }) : Response.json({ journals: [] })));
  render(React.createElement(JournalPanel, { sessionId: "s", cycleId: "c", currentUserId: "owner" }));
  const field = await screen.findByLabelText("오늘 한 일") as HTMLTextAreaElement;
  fireEvent.change(field, { target: { value: "먼저 입력" } }); fireEvent.click(screen.getByRole("button", { name: /임시 저장/ }));
  await waitFor(() => expect(complete).toBeTypeOf("function"));
  fireEvent.change(field, { target: { value: "먼저 입력 그리고 추가 입력" } });
  await act(async () => complete(Response.json({ journal: { id: "saved", sessionNumber: 1, date: "2026-10-20", activities: "먼저 입력", observations: "", reflections: "", version: 1, images: [] } })));
  expect(field.value).toBe("먼저 입력 그리고 추가 입력");
  expect(fake.remove).not.toHaveBeenCalled();
  expect(fake.put.mock.calls.at(-1)![0].activities).toBe(field.value);
});

class FakeRecorder {
  static isTypeSupported() { return true; }
  state = "inactive"; mimeType = "audio/webm";
  ondataavailable?: (event: { data: Blob }) => void; onstop?: () => void;
  start() { this.state = "recording"; }
  stop() { this.state = "inactive"; this.ondataavailable?.({ data: new Blob(["synthetic speech"], { type: this.mimeType }) }); this.onstop?.(); }
}
function microphone() {
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) } });
}
it("offers the full transcript for explicit append to the latest memo, without overwriting typing", async () => {
  microphone(); let complete!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { complete = resolve; })));
  const change = vi.fn(); const props = { sessionId: "s", cycleId: "c", currentUserId: "owner", value: "처음 메모", onChange: change };
  const { rerender } = render(React.createElement(MeetingAudioInput, props));
  fireEvent.click(screen.getByRole("button", { name: /음성으로 메모/ }));
  fireEvent.click(await screen.findByRole("button", { name: /녹음 마침/ }));
  rerender(React.createElement(MeetingAudioInput, { ...props, value: "처음 메모 + 기다리는 동안 추가" }));
  await act(async () => complete(Response.json({ text: "전사된 실험 관찰" })));
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "현재 메모에 덧붙이기" }));
  expect(change).toHaveBeenCalledWith("처음 메모 + 기다리는 동안 추가\n\n전사된 실험 관찰");
});
it("does not truncate overlong transcripts and clears previews on account change", async () => {
  microphone(); vi.stubGlobal("fetch", vi.fn(async () => Response.json({ text: "가".repeat(16001) })));
  const change = vi.fn(); const props = { sessionId: "s", cycleId: "c", currentUserId: "owner", value: "", onChange: change };
  const { rerender } = render(React.createElement(MeetingAudioInput, props));
  fireEvent.click(screen.getByRole("button", { name: /음성으로 메모/ })); fireEvent.click(await screen.findByRole("button", { name: /녹음 마침/ }));
  expect((await screen.findByLabelText("전사문 확인") as HTMLTextAreaElement).value.length).toBe(16001);
  expect((screen.getByRole("button", { name: "현재 메모에 덧붙이기" }) as HTMLButtonElement).disabled).toBe(true);
  rerender(React.createElement(MeetingAudioInput, { ...props, currentUserId: "peer" }));
  expect(screen.queryByLabelText("전사문 확인")).toBeNull(); expect(change).not.toHaveBeenCalled();
});
