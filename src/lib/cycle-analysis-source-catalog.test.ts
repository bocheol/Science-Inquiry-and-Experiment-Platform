import { expect, it } from "vitest";
import { prepareCycleAnalysisInput } from "@/lib/cycle-analysis";
import type { CycleEvidenceSnapshot } from "@/lib/cycle-evidence";

const snapshot: CycleEvidenceSnapshot = {
  id: "snapshot-current",
  planSnapshotId: "plan-snapshot-current",
  contentHash: "synthetic-hash",
  createdAt: "2026-09-09T00:00:00.000Z",
  cycle: { id: "cycle-current", sessionId: "session", ordinal: 2, title: "2회차", status: "active", origin: "configured", startedAt: null, endedAt: null },
  plan: { id: "plan", reviewStatus: "approved", formData: { topic: "합성 주제" }, configVersionId: null, configDefinition: {}, updatedAt: "2026-09-09T00:00:00.000Z" },
  report: { id: "report", status: "reviewed", formData: { result: "합성 결과" }, memberRoles: [], configVersionId: null, configDefinition: {}, updatedAt: "2026-09-09T00:00:00.000Z" },
  materialRequests: [
    { id: "official-material", items: [{ name: "비커" }], totalAmount: 1000, syncStatus: "synced", submittedAt: "2026-09-09T00:00:00.000Z" },
    { id: "practice-material", items: [{ name: "연습용 비커" }], totalAmount: 0, syncStatus: "skipped", submittedAt: "2026-09-09T00:00:00.000Z", isPractice: true },
  ],
  journals: [],
  messages: [],
  discussionSummaries: [],
  trajectoryContext: [{
    cycleId: "cycle-prior", ordinal: 1, title: "1회차", analysisId: "analysis-prior", analysisType: "intermediate", result: { summary: "합성 이전 분석" }, decisions: [],
  }],
};

it("includes official materials and existing prior analysis without practice data or invented decisions", () => {
  const prepared = prepareCycleAnalysisInput(snapshot, (text) => text);
  expect(prepared.sourceIds).toContain("material:official-material");
  expect(prepared.sourceIds).not.toContain("material:practice-material");
  expect(prepared.sourceIds).toContain("prior-analysis:analysis-prior");
  expect(prepared.sourceIds.some((id) => id.startsWith("prior-decision:"))).toBe(false);
  expect(prepared.text).toContain("비커");
  expect(prepared.text).not.toContain("연습용 비커");
});
