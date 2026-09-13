import { beforeEach, expect, it, vi } from "vitest";
import { FormWriteConflict } from "@/lib/form-write-conflict";
import { UserFacingError } from "@/lib/user-facing-error";
import { PATCH } from "@/app/api/inquiry/plan/route";

const mocks = vi.hoisted(() => ({
  savePlanField: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => ({ id: "synthetic-student", role: "student", mustChangePassword: false }),
}));
vi.mock("@/lib/db", () => ({
  getDb: async () => ({ query: async () => ({ rows: [{ session_id: "synthetic-session" }] }) }),
}));
vi.mock("@/lib/inquiry-data", () => ({ assertActiveTeamMember: vi.fn() }));
vi.mock("@/lib/plan-service", () => ({
  savePlanField: mocks.savePlanField,
  submitPlan: vi.fn(),
}));
vi.mock("@/lib/document-history", () => ({ restorePlanRevision: vi.fn() }));

function request() {
  return new Request("http://localhost/api/inquiry/plan", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cycleId: "synthetic-cycle", planId: "synthetic-plan", fieldKey: "purpose", value: "합성 내용" }),
  });
}

beforeEach(() => mocks.savePlanField.mockReset());

it("hides unexpected document storage details from the response", async () => {
  mocks.savePlanField.mockRejectedValueOnce(new Error("postgresql://internal-user:secret@private-host/student-data"));

  const response = await PATCH(request());
  const body = await response.json();

  expect(response.status).toBe(409);
  expect(body.message).toBe("저장하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  expect(JSON.stringify(body)).not.toContain("secret");
});

it("preserves explicitly classified document conflict guidance", async () => {
  const message = "다른 팀원이 이 항목을 작성 중입니다.";
  mocks.savePlanField.mockRejectedValueOnce(new UserFacingError(message));

  const response = await PATCH(request());

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ message });
  expect(new FormWriteConflict()).toBeInstanceOf(UserFacingError);
});
