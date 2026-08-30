import { describe, expect, it } from "vitest";
import { generateTemporaryPassword, hangulToDubeolsik, isAcceptablePassword } from "@/lib/passwords";

describe("temporary passwords", () => {
  it("generates classroom-friendly passwords that meet the policy", () => {
    for (let index = 0; index < 30; index += 1) {
      const password = generateTemporaryPassword();
      expect(isAcceptablePassword(password)).toBe(true);
      expect(password).not.toMatch(/[가-힣]/);
    }
  });

  it("converts Korean syllables to the same Dubeolsik QWERTY keystrokes", () => {
    expect(hangulToDubeolsik("체험")).toBe("cpgja");
    expect(hangulToDubeolsik("AI 체험 2026!")).toBe("AI cpgja 2026!");
  });

  it("rejects passwords without a number or with fewer than eight characters", () => {
    expect(isAcceptablePassword("abcdefgh")).toBe(false);
    expect(isAcceptablePassword("가나다123")).toBe(false);
  });
});
