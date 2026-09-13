import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocumentDiffView } from "@/components/document-diff-view";
import type { DocumentVersion, VersionComparison } from "./document-version-types";

function version(label: string, values: Record<string, unknown>, fields: DocumentVersion["fields"]): DocumentVersion {
  return {
    ref: { kind: "revision", id: label },
    sourceKey: label,
    label,
    eventAt: "2026-09-13T00:00:00.000Z",
    fingerprint: label,
    capturedAt: "2026-09-13T00:00:00.000Z",
    fields,
    definitionVerified: true,
    values,
    roles: [],
    status: "draft",
    feedback: null,
    issues: [],
    valid: true,
  };
}

describe("whole document version comparison", () => {
  it("shows all fields in aligned A/B rows by default and preserves missing space", () => {
    const common = { id: "same", label: "공통 항목", kind: "long_text", required: false } as const;
    const removed = { id: "removed", label: "삭제된 항목", kind: "long_text", required: false } as const;
    const added = { id: "added", label: "추가된 항목", kind: "long_text", required: false } as const;
    const comparison: VersionComparison = {
      scope: { documentType: "plan", documentId: "plan-1", cycleId: "cycle-1" },
      a: version("기준본", { same: "같은 내용", removed: "이전 내용" }, [common, removed]),
      b: version("비교본", { same: "같은 내용", added: "새 내용" }, [common, added]),
    };

    const html = renderToStaticMarkup(React.createElement(DocumentDiffView, { comparison }));

    expect(html).toContain("문서 전체 좌우 비교");
    expect(html).toContain("A · 기준본");
    expect(html).toContain("B · 비교본");
    expect(html).toContain('aria-pressed="true">전체 문서');
    expect(html).toContain('data-field-key="same"');
    expect(html).toContain('data-field-key="removed"');
    expect(html).toContain('data-field-key="added"');
    expect(html.match(/내용 없음/g)).toHaveLength(3);
    expect(html).not.toContain("같은 내용 생략");
  });
});
