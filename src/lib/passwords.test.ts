import { describe, expect, it } from "vitest";
import { generateTemporaryPassword, isAcceptablePassword } from "@/lib/passwords";

describe("temporary passwords", () => {
  it("generates classroom-friendly passwords that meet the policy", () => {
    for (let index = 0; index < 30; index += 1) {
      expect(isAcceptablePassword(generateTemporaryPassword())).toBe(true);
    }
  });

  it("rejects passwords without a number or with fewer than eight characters", () => {
    expect(isAcceptablePassword("abcdefgh")).toBe(false);
    expect(isAcceptablePassword("가나다123")).toBe(false);
  });
});
