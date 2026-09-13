import { describe, expect, it } from "vitest";
import { DocumentDrafts } from "@/lib/document-drafts";

describe("document input preservation", () => {
  it("keeps the next field when a previous field saves and stale polling arrives", () => {
    const drafts = new DocumentDrafts();
    drafts.change("topic", "new topic", "old topic");
    const sent = { ...drafts.entries.topic };
    drafts.change("purpose", "still typing", "");
    drafts.acknowledge("topic", sent);
    drafts.reconcile({ topic: "old topic", purpose: "" });
    expect(drafts.values({})).toEqual({ topic: "new topic", purpose: "still typing" });
    drafts.reconcile({ topic: "new topic", purpose: "" });
    expect(drafts.pendingKeys).toEqual(["purpose"]);
  });
  it("preserves typing during an in-flight save and advances only the server baseline", () => {
    const drafts = new DocumentDrafts();
    drafts.change("method", "first", "original");
    const sent = { ...drafts.entries.method };
    drafts.change("method", "first plus more", "original");
    drafts.acknowledge("method", sent);
    drafts.reconcile({ method: "first" });
    expect(drafts.entries.method).toMatchObject({ value: "first plus more", baseValue: "first", saved: false });
  });
  it("restores unsaved and unconfirmed saves after reload without applying a teammate's value", () => {
    const drafts = new DocumentDrafts();
    drafts.change("schedule", [{ date: "2026-09-07", work: "test" }], []);
    const restored = new DocumentDrafts();
    restored.restore(JSON.stringify(drafts.entries));
    restored.reconcile({ schedule: [{ work: "teammate" }] });
    expect(restored.entries.schedule.value).toEqual([{ date: "2026-09-07", work: "test" }]);
    expect(restored.entries.schedule.baseValue).toEqual([]);
  });
  it("retains explicit empty, false and array values", () => {
    const drafts = new DocumentDrafts();
    drafts.change("text", "", "old");
    drafts.change("check", false, true);
    drafts.change("choices", [], ["a"]);
    expect(drafts.values({ text: "old", check: true, choices: ["a"] })).toEqual({ text: "", check: false, choices: [] });
  });
});
