// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PrivateSessionBoundary } from "@/components/private-session-boundary";

const fake = vi.hoisted(() => ({ seal: vi.fn(async () => undefined), lock: vi.fn(), flush: vi.fn(async () => undefined) }));
vi.mock("@/lib/journal-recovery-client", () => ({ sealLegacyJournalDrafts: fake.seal, retryJournalRecoveries: vi.fn(), lockJournalRecoveries: fake.lock, flushJournalRecoveries: fake.flush }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete document.documentElement.dataset.privateLocked; });

it("removes the old private DOM on account switch even if an earlier identity response arrives late", async () => {
  document.cookie = "science-session-marker=owner-marker";
  let complete!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { complete = resolve; })));
  render(React.createElement(PrivateSessionBoundary, { ownerId: "owner", marker: "owner-marker", children: React.createElement("p", null, "합성 학생의 이전 화면") }));
  expect(screen.getByText("합성 학생의 이전 화면").closest("[data-private-screen]")?.hasAttribute("hidden")).toBe(true);
  await waitFor(() => expect(complete).toBeTypeOf("function"));
  act(() => { document.cookie = "science-session-marker=peer-marker"; window.dispatchEvent(new StorageEvent("storage", { key: "science-private-session-change" })); });
  expect(screen.queryByText("합성 학생의 이전 화면")).toBeNull();
  await act(async () => complete(Response.json({ userId: "owner", sessionMarker: "owner-marker" })));
  expect(screen.queryByText("합성 학생의 이전 화면")).toBeNull(); expect(document.documentElement.dataset.privateLocked).toBe("true");
});
it("permits server saving with an explicit warning when the device store is unavailable", async () => {
  document.cookie = "science-session-marker=owner-marker";
  fake.seal.mockRejectedValueOnce(new Error("synthetic storage failure"));
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ userId: "owner", sessionMarker: "owner-marker" })));
  render(React.createElement(PrivateSessionBoundary, { ownerId: "owner", marker: "owner-marker", children: React.createElement("p", null, "검증된 계정 화면") }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "기기 복구 저장소를 사용할 수 없습니다. 서버 저장 상태를 확인해 주세요.");
  expect(screen.getByText("검증된 계정 화면").closest("[data-private-screen]")?.hasAttribute("hidden")).toBe(false);
});
