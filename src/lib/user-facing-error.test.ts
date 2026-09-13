import { expect, it } from "vitest";
import { userFacingAiError } from "@/lib/ai";
import { UserFacingError, userFacingMessage } from "@/lib/user-facing-error";

it("does not expose an unexpected internal error message", () => {
  const error = new Error("postgresql://internal-user:secret@private-host/student-data");
  const message = userFacingAiError(error);
  expect(message).toBe("AI 답변을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.");
  expect(message).not.toContain("secret");
  expect(userFacingMessage(error, "안전한 안내")).toBe("안전한 안내");
});

it("preserves only an explicitly marked user action message", () => {
  const error = new UserFacingError("탐구 회차가 변경되었습니다. 현재 회차를 확인해 주세요.");
  expect(userFacingAiError(error)).toBe(error.message);
  expect(userFacingMessage(error, "다시 시도해 주세요.")).toBe(error.message);
});
