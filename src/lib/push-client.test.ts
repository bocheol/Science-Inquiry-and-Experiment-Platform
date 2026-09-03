import { describe, expect, it } from "vitest";
import {
  canShowPushAction,
  getBlockedPushInstructions,
  getPushActionLabel,
  type PushClientState,
} from "@/lib/push-client";

describe("push permission retry UI", () => {
  it("keeps the action visible after permission is blocked", () => {
    expect(canShowPushAction("blocked", false)).toBe(true);
    expect(getPushActionLabel("blocked")).toBe("알림 다시 켜기");
  });

  it("hides actions that cannot be completed yet", () => {
    const hiddenStates: PushClientState[] = ["checking", "unsupported", "unconfigured"];
    expect(hiddenStates.every((state) => !canShowPushAction(state, false))).toBe(true);
    expect(canShowPushAction("blocked", true)).toBe(false);
  });

  it("provides device-specific instructions without pretending to reopen system permission", () => {
    expect(getBlockedPushInstructions(true)).toContain("설정 → 알림 → 과탐실 AI");
    expect(getBlockedPushInstructions(false)).toContain("사이트 설정 또는 기기 설정");
  });
});
