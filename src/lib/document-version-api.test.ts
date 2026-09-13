import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/document-version-reader", async importOriginal => ({ ...await importOriginal<object>(), listDocumentVersions: vi.fn(), compareDocumentVersions: vi.fn() }));
import { getCurrentUser } from "./auth";
import { compareDocumentVersions, listDocumentVersions, DocumentVersionError } from "./document-version-reader";
import { documentVersionGet } from "./document-version-api";
const user = { id: "synthetic", role: "student", mustChangePassword: false } as Awaited<ReturnType<typeof getCurrentUser>>;
const query = "documentType=plan&documentId=plan&cycleId=cycle";
beforeEach(() => { vi.resetAllMocks(); vi.mocked(getCurrentUser).mockResolvedValue(user); });
describe("private version API", () => {
  it("rejects unauthenticated reads before evaluating identifiers", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    const response = await documentVersionGet(new Request("http://local/?"), "compare");
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(compareDocumentVersions).not.toHaveBeenCalled();
  });
  it("requires a revision id on both independently selected sides", async () => {
    const response = await documentVersionGet(new Request(`http://local/?${query}&aKind=revision&bKind=revision&bId=past`), "compare");
    expect(response.status).toBe(400);
  });
  it("accepts past versus past", async () => {
    vi.mocked(compareDocumentVersions).mockResolvedValue({ synthetic: true } as never);
    const response = await documentVersionGet(new Request(`http://local/?${query}&aKind=revision&aId=yesterday&bKind=revision&bId=lastweek`), "compare");
    expect(response.status).toBe(200);
    expect(compareDocumentVersions).toHaveBeenCalledWith(user, { documentType: "plan", documentId: "plan", cycleId: "cycle" }, { kind: "revision", id: "yesterday" }, { kind: "revision", id: "lastweek" }, { a: undefined, b: undefined });
  });
  it("discards a result if the session changed during the read", async () => {
    vi.mocked(getCurrentUser).mockResolvedValueOnce(user).mockResolvedValueOnce(null);
    vi.mocked(listDocumentVersions).mockResolvedValue({ synthetic: true } as never);
    const response = await documentVersionGet(new Request(`http://local/?${query}`), "list");
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("synthetic");
  });
  it("returns current-version conflict without a stale body", async () => {
    vi.mocked(compareDocumentVersions).mockRejectedValue(new DocumentVersionError("저장본이 바뀌었습니다.", 409));
    const response = await documentVersionGet(new Request(`http://local/?${query}&aKind=current&bKind=revision&bId=past`), "compare");
    expect(response.status).toBe(409);
  });
});
