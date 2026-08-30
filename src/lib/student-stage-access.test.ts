import { describe, expect, it } from "vitest";
import { getStudentStageAccess } from "@/lib/student-stage-access";

describe("student locked-stage guidance", () => {
  it("distinguishes plan approval from material submission for journals", () => {
    expect(getStudentStageAccess("pending", false)).toMatchObject({
      journalAvailable: false,
      reportAvailable: false,
      journalLockedMessage: expect.stringContaining("승인"),
    });
    expect(getStudentStageAccess("approved", false)).toMatchObject({
      journalAvailable: false,
      reportAvailable: true,
      journalLockedMessage: expect.stringContaining("준비물 신청"),
    });
    expect(getStudentStageAccess("approved", true)).toMatchObject({
      journalAvailable: true,
      reportAvailable: true,
      journalLockedMessage: null,
    });
  });
});
