import { describe, expect, it } from "vitest";
import { dismissToast, enqueueToast } from "@/lib/toast-queue";

describe("global toast queue", () => {
  it("keeps consecutive results instead of overwriting an earlier message", () => {
    const first = enqueueToast([], { id: 1, message: "첫 작업 완료" });
    const second = enqueueToast(first, { id: 2, message: "둘째 작업 완료" });
    expect(second.map((item) => item.message)).toEqual(["첫 작업 완료", "둘째 작업 완료"]);
    expect(dismissToast(second, 1).map((item) => item.message)).toEqual(["둘째 작업 완료"]);
  });
});
