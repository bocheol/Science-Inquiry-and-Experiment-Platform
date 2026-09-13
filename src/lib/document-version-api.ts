import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { compareDocumentVersions, DocumentVersionError, listDocumentVersions } from "@/lib/document-version-reader";
import type { VersionRef } from "@/lib/document-version-types";

const id = z.string().min(1).max(200);
const scopeSchema = z.object({ documentType: z.enum(["plan", "report"]), documentId: id, cycleId: id });
const listSchema = scopeSchema.extend({ cursor: z.string().max(2000).optional(), fromDate: z.string().max(10).optional(), toDate: z.string().max(10).optional() });
const compareSchema = scopeSchema.extend({
  aKind: z.enum(["current", "revision", "cycle_final"]), aId: id.optional(),
  bKind: z.enum(["current", "revision", "cycle_final"]), bId: id.optional(),
  aFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(), bFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).refine(value => (value.aKind !== "revision" || Boolean(value.aId)) && (value.bKind !== "revision" || Boolean(value.bId)));
const headers = { "Cache-Control": "private, no-store" };

export async function documentVersionGet(request: Request, mode: "list" | "compare") {
  try {
    const user = await getCurrentUser();
    if (!user || user.mustChangePassword) return NextResponse.json({ message: "권한이 없습니다." }, { status: 403, headers });
    const query = Object.fromEntries(new URL(request.url).searchParams);
    const scope = scopeSchema.safeParse(query);
    if (!scope.success) return NextResponse.json({ message: "문서와 회차를 확인해 주세요." }, { status: 400, headers });
    let result;
    if (mode === "list") {
      const parsed = listSchema.safeParse(query);
      if (!parsed.success) throw new DocumentVersionError("조회 조건을 확인해 주세요.", 400);
      result = await listDocumentVersions(user, scope.data, parsed.data);
    } else {
      const parsed = compareSchema.safeParse(query);
      if (!parsed.success) throw new DocumentVersionError("비교할 두 버전을 선택해 주세요.", 400);
      const input = parsed.data;
      const a: VersionRef = { kind: input.aKind, id: input.aKind === "revision" ? input.aId : undefined };
      const b: VersionRef = { kind: input.bKind, id: input.bKind === "revision" ? input.bId : undefined };
      result = await compareDocumentVersions(user, scope.data, a, b, { a: input.aFingerprint, b: input.bFingerprint });
    }
    const current = await getCurrentUser();
    if (!current || current.id !== user.id || current.role !== user.role || current.mustChangePassword) throw new DocumentVersionError("권한이 변경되었습니다. 다시 로그인해 주세요.", 403);
    return NextResponse.json(result, { headers });
  } catch (error) {
    return NextResponse.json({ message: error instanceof DocumentVersionError ? error.message : "기록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요." }, { status: error instanceof DocumentVersionError ? error.status : 500, headers });
  }
}
