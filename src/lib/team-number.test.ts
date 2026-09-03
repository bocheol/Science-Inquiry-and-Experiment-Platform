import { describe, expect, it } from "vitest";
import { findNextAvailableTeamNumber } from "@/lib/team-number";

describe("next available classroom team number", () => {
  it("ignores special teams outside the classroom range", () => {
    expect(findNextAvailableTeamNumber([99])).toBe(1);
  });

  it("fills the first gap instead of always adding after the largest number", () => {
    expect(findNextAvailableTeamNumber([1, 3, 4])).toBe(2);
  });

  it("reserves numbers used by active and archived teams", () => {
    expect(findNextAvailableTeamNumber([1, 2, 3, 4, 5, 6, 7])).toBe(8);
  });

  it("returns null when all classroom team numbers are occupied", () => {
    expect(findNextAvailableTeamNumber(Array.from({ length: 20 }, (_, index) => index + 1))).toBeNull();
  });
});
