// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StudentRecordsWorkspace, type RecordsRequest } from "./workspace";
import { TeacherRecordEditor } from "./forms";
import { PrivateSessionBoundary } from "@/components/private-session-boundary";
import type { RecordWorkspace } from "@/lib/student-records/model";

vi.mock("@/lib/journal-recovery-client", () => ({
  sealLegacyJournalDrafts: vi.fn(async () => undefined), retryJournalRecoveries: vi.fn(),
  lockJournalRecoveries: vi.fn(), flushJournalRecoveries: vi.fn(async () => undefined),
}));

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
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; host?.remove(); vi.unstubAllGlobals(); delete document.documentElement.dataset.privateLocked; document.cookie = "science-session-marker=; max-age=0"; });

describe("record editing and shared-device boundaries", () => {
  it("preserves unsaved record text inside the journal privacy boundary and clears it after another login", async () => {
    let switched = false;
    document.cookie = "science-session-marker=records-owner-marker";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => switched ? Response.json({ message: "계정이 변경되었습니다." }, { status: 403 }) : Response.json(url === "/api/auth/identity" ? { userId: "synthetic-owner", sessionMarker: "records-owner-marker" } : url.includes("identity") ? { id: "synthetic-owner" } : fixture())));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await mount(createElement(PrivateSessionBoundary, { ownerId: "synthetic-owner", marker: "records-owner-marker", children: createElement(StudentRecordsWorkspace, { user: { id: "synthetic-owner", role: "student" } }) }));
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
    expect(document.documentElement.dataset.privateLocked).toBeUndefined();
    switched = true;
    await act(async () => { document.cookie = "science-session-marker=records-peer-marker"; window.dispatchEvent(new StorageEvent("storage", { key: "science-private-session-change" })); window.dispatchEvent(new Event("focus")); });
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
  it("clears an old editor before explicitly saving a fresh draft after a scope change", async () => {
    const current = fixture();
    const fresh: RecordWorkspace = { ...current, draft: { revision: 4, sourceRevision: 0, course1: "", course2: "", notes: "",
      checkedGroups: [], status: "draft", evidence: null, ai: null, previousDraftHidden: true } };
    let changed = false;
    const requests: { action: string; data: { startNewDraft?: boolean; course1?: string; course2?: string; expectedRevision?: number } }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.includes("identity=1")) return Response.json({ id: "synthetic-teacher" });
      if (init?.method === "POST") { requests.push(JSON.parse(init.body as string)); return Response.json({ revision: 6 }); }
      if (url.includes("studentId=")) return Response.json(changed ? fresh : current);
      return Response.json({ students: [current.student], settings: current.settings });
    });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await mount(createElement(StudentRecordsWorkspace, { user: { id: "synthetic-teacher", role: "teacher" } }));
    await click([...host.querySelectorAll("button")].find(b => b.textContent?.includes("10901 합성"))!);
    expect([...host.querySelectorAll("textarea")].some(t => t.value === "기존 교사 작성문")).toBe(true);
    changed = true;
    await click([...host.querySelectorAll("button")].find(b => b.textContent === "최신 저장본 불러오기")!);
    await click([...host.querySelectorAll("button")].find(b => b.textContent === "비교했습니다 · 내 작성란으로 계속 작성")!);
    expect([...host.querySelectorAll("textarea")].some(t => t.value === "기존 교사 작성문")).toBe(false);
    expect(host.textContent).toContain("이전 작성본은 보관했습니다");
    await click([...host.querySelectorAll("button")].find(b => b.textContent === "작성본 저장")!);
    expect(requests.find(r => r.action === "draft")?.data).toMatchObject({ startNewDraft: true, expectedRevision: 4, course1: "", course2: "" });
  });

});
