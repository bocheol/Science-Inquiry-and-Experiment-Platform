import { describe, expect, it } from "vitest";
import {
  containsRestrictedTeacherRequestData,
  createTeacherRequest,
  listTeacherRequests,
  updateTeacherRequestStatus,
} from "@/lib/teacher-requests";
import type { SessionUser } from "@/lib/types";

const teacher: SessionUser = {
  id: "teacher_bootstrap", name: "교사", loginId: "teacher", role: "teacher", academicYear: 2026,
  classId: null, classNumber: null, mustChangePassword: false,
};
const student: SessionUser = {
  id: "demo_student_1", name: "학생", loginId: "10901", role: "student", academicYear: 2026,
  classId: "class_2026_9", classNumber: 9, mustChangePassword: false,
};

describe("internal teacher request board", () => {
  it("rejects likely student identifiers and secret data", () => {
    expect(containsRestrictedTeacherRequestData("학생 학번 10901의 자료를 확인해 주세요")).toBe(true);
    expect(containsRestrictedTeacherRequestData("비밀번호가 동작하지 않습니다")).toBe(true);
    expect(containsRestrictedTeacherRequestData("태블릿에서 버튼 간격을 넓혀 주세요")).toBe(false);
  });

  it("allows teachers to share requests and blocks students", async () => {
    await expect(createTeacherRequest(student, { category: "feature", title: "기능 요청", content: "버튼을 추가해 주세요." })).rejects.toThrow("권한");
    await expect(listTeacherRequests(student)).rejects.toThrow("권한");

    const id = await createTeacherRequest(teacher, {
      category: "feature",
      title: "태블릿 화면 개선",
      content: "준비물 입력 버튼의 간격을 조금 더 넓혀 주세요.",
    });
    await updateTeacherRequestStatus(teacher, id, "reviewing");
    expect((await listTeacherRequests(teacher)).find((item) => item.id === id)).toMatchObject({
      authorName: "과학 선생님",
      category: "feature",
      status: "reviewing",
    });
  });
});
