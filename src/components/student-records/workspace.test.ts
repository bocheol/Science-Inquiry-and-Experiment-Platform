// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StudentRecordsWorkspace, type RecordsRequest } from "./workspace";
import { TeacherRecordEditor } from "./forms";
import type { RecordWorkspace } from "@/lib/student-records/model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLDivElement;
const fixture = (): RecordWorkspace => ({
  student: { id: "synthetic-owner", name: "합성 학생 이름", loginId: "10901", classNumber: 9, status: "active", submissionStatus: "draft", draftStatus: "draft" },
  submission: { studentId: "synthetic-owner", revision: 0, selected: ["egg", "spectrum"], comments: {}, status: "draft", returnedNote: "", reopenedUntil: null },
  settings: { revision: 0, style: "", opensAt: null, deadlineAt: null, folderId: "", spreadsheetId: "" }, files: [],
  draft: { revision: 0, sourceRevision: 0, course1: "기존 교사 작성문", course2: "기존 두 번째 과목", notes: "", checkedGroups: [], status: "draft", evidence: null, ai: null },
  evidence: { sources: [], missing: [], hash: "a".repeat(64), collectedAt: new Date().toISOString() },
});
async function mount(element: ReturnType<typeof createElement>) { host = document.createElement("div"); document.body.append(host); root = createRoot(host); await act(async () => { root!.render(element); }); }
async function click(button: Element) { await act(async () => { (button as HTMLElement).click(); }); }
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; host?.remove(); vi.unstubAllGlobals(); });

describe("record editing and shared-device boundaries", () => {
  it("keeps unsaved activity text across tab hiding/focus and removes it after another login", async () => {
    let switched = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => switched ? Response.json({ message: "계정이 변경되었습니다." }, { status: 403 }) : Response.json(url.includes("identity") ? { id: "synthetic-owner" } : fixture())));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await mount(createElement(StudentRecordsWorkspace, { user: { id: "synthetic-owner", role: "student" } }));
    const textarea = host.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "아직 저장하지 않은 중요한 관찰");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
    expect(textarea.closest("[hidden]")).not.toBeNull();
    await act(async () => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
    expect(host.querySelector("textarea")!.value).toBe("아직 저장하지 않은 중요한 관찰");
    expect(host.querySelector("textarea")!.closest("[hidden]")).toBeNull();
    switched = true;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.textContent).not.toContain("합성 학생 이름");
    expect(host.textContent).not.toContain("아직 저장하지 않은 중요한 관찰");
  });
  it("previews generated text without replacing teacher prose until explicitly applied", async () => {
    const workspace = fixture();
    const request = vi.fn(async () => ({ result: { course1: "검토할 새 AI 초안", course2: "두 번째 새 AI 초안", claims: [], warnings: ["교사 확인 필요"] }, evidenceHash: workspace.evidence!.hash })) as unknown as RecordsRequest;
    await mount(createElement(TeacherRecordEditor, { workspace, request, onChanged: async () => {}, onDirty: vi.fn() }));
    await click([...host.querySelectorAll("button")].find(b => b.textContent === "근거로 AI 초안 만들기")!);
    expect([...host.querySelectorAll("textarea")].some(t => t.value === "기존 교사 작성문")).toBe(true);
    expect(host.textContent).toContain("검토할 새 AI 초안");
    await click([...host.querySelectorAll("button")].find(b => b.textContent === "이 초안을 작성란에 적용")!);
    expect([...host.querySelectorAll("textarea")].some(t => t.value === "검토할 새 AI 초안")).toBe(true);
    expect([...host.querySelectorAll("textarea")].some(t => t.value === "기존 교사 작성문")).toBe(false);
  });
});
