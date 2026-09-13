import { describe, expect, it } from "vitest";
import { compareVersionContents, diffText } from "./document-diff";
import type { DocumentVersion } from "./document-version-types";

function version(values: Record<string, unknown>, extras: Partial<DocumentVersion> = {}): DocumentVersion {
  return { ref: { kind: "revision", id: "synthetic" }, sourceKey: "synthetic", label: "합성", eventAt: null, fingerprint: "test", capturedAt: "", fields: [], definitionVerified: true, values, roles: [], status: "draft", feedback: null, issues: [], valid: true, ...extras };
}
describe("document comparison semantics", () => {
  it("reconstructs Korean, whitespace and combined emoji without breaking graphemes", () => {
    const a = "관찰 👨‍👩‍👧‍👦\n기온  20℃", b = "관찰 👩‍🔬\n기온 21℃";
    const parts = diffText(a, b);
    expect(parts.filter(p => p.kind !== "added").map(p => p.text).join("")).toBe(a);
    expect(parts.filter(p => p.kind !== "deleted").map(p => p.text).join("")).toBe(b);
    expect(parts.find(p => p.kind === "deleted")?.text).toContain("👨‍👩‍👧‍👦");
  });
  it("distinguishes missing, blank, false and zero; ignores object key order", () => {
    const result = compareVersionContents(version({ blank: "", flag: false, zero: 0, object: { x: 1, y: 2 }, removed: "내용" }), version({ blank: null, flag: false, zero: 0, object: { y: 2, x: 1 }, new: "추가" }));
    expect(Object.fromEntries(result.fields.map(f => [f.key, f.kind]))).toEqual({ blank: "modified", flag: "same", zero: "same", object: "same", removed: "deleted", new: "added" });
  });
  it("compares typed choice sets and numbers while preserving raw values", () => {
    const fields: DocumentVersion["fields"] = [{ id: "n", label: "수", kind: "number", required: false }, { id: "s", label: "선택", kind: "multiple_choice", required: false }];
    const result = compareVersionContents(version({ n: "0", s: '["나","가"]' }, { fields }), version({ n: 0, s: ["가", "나"] }, { fields }));
    expect(result.fields.every(f => f.kind === "same")).toBe(true);
    expect(result.fields[0].before).toBe("0");
  });
  it("aligns table insertion without marking following rows changed", () => {
    const fields: DocumentVersion["fields"] = [{ id: "t", label: "측정", kind: "table", required: false, columns: [{ id: "v", label: "값", kind: "short_text" }] }];
    const result = compareVersionContents(version({ t: [{ v: "가" }, { v: "나" }] }, { fields }), version({ t: [{ v: "추가" }, { v: "가" }, { v: "나" }] }, { fields }));
    expect(result.fields[0].rows?.map(r => r.kind)).toEqual(["added", "same", "same"]);
  });
  it("keeps removed members by identity and separates status from body", () => {
    const result = compareVersionContents(version({}, { roles: [{ userId: "former", label: "이전 팀원", description: "측정" }] }), version({}, { status: "approved", roles: [{ userId: "former", label: "이름 변경", description: "분석" }] }));
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0].kind).toBe("modified");
    expect(result.metadata.find(f => f.key === "status")?.kind).toBe("modified");
  });
  it("does not convert malformed table JSON to empty rows", () => {
    const fields: DocumentVersion["fields"] = [{ id: "t", label: "표", kind: "table", required: false, columns: [] }];
    const result = compareVersionContents(version({ t: "{" }, { fields }), version({ t: [] }, { fields }));
    expect(result.fields[0]).toMatchObject({ kind: "unknown", before: "{" });
  });
  it("bounds long text comparison and retains both full originals", () => {
    const a = "가".repeat(50000), b = "나".repeat(50000);
    const result = compareVersionContents(version({ t: a }), version({ t: b }));
    expect(result.limited).toBe(true);
    expect(result.fields[0]).toMatchObject({ before: a, after: b, kind: "modified" });
  });
});
