import { describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import {
  createAnnouncement,
  listStudentNotices,
  listTeacherAnnouncements,
  markNoticeRead,
  setAnnouncementArchived,
  updateAnnouncement,
} from "@/lib/notices";
import { reviewPlan, submitPlan } from "@/lib/plan-service";
import { reviewReport } from "@/lib/report-service";
import type { SessionUser } from "@/lib/types";

const teacher: SessionUser = {
  id: "teacher_bootstrap", name: "시험 교사", loginId: "teacher", role: "teacher",
  academicYear: 2026, classId: null, classNumber: null, mustChangePassword: false,
};

const teamStudent: SessionUser = {
  id: "demo_student_1", name: "시험 학생", loginId: "10901", role: "student",
  academicYear: 2026, classId: "class_2026_9", classNumber: 9, mustChangePassword: false,
};

describe("notice and notification mailbox", () => {
  it("targets all, class, and team notices and tracks each student's reads", async () => {
    const db = await getDb();
    await db.query(
      `INSERT INTO users
        (id, name, login_id, academic_year, role, class_id, password_hash, must_change_password)
       VALUES ('notice_other_student', '다른반시험학생', '10897', 2026, 'student', 'class_2026_8', 'unused', FALSE)`,
    );
    const otherStudent: SessionUser = {
      id: "notice_other_student", name: "다른반시험학생", loginId: "10897", role: "student",
      academicYear: 2026, classId: "class_2026_8", classNumber: 8, mustChangePassword: false,
    };

    const globalId = await createAnnouncement(teacher, {
      title: "전체 수업 안내", content: "다음 수업 준비 사항을 확인하세요.", audienceType: "all",
      priority: "important", calendarStart: "2026-09-03", calendarEnd: "2026-09-04",
    });
    const classId = await createAnnouncement(teacher, {
      title: "학급 안내", content: "학급별 안내입니다.", audienceType: "class", classNumber: 9, priority: "normal",
    });
    const teamId = await createAnnouncement(teacher, {
      title: "팀 안내", content: "현재 팀원에게만 보이는 안내입니다.", audienceType: "team", teamId: "demo_team_1", priority: "normal",
    });

    const teamFeed = await listStudentNotices(teamStudent);
    expect(teamFeed.notices.map((notice) => notice.id)).toEqual(expect.arrayContaining([globalId, classId, teamId]));
    expect(teamFeed.popupNotice?.id).toBe(globalId);
    expect(teamFeed.notices.find((notice) => notice.id === globalId)).toMatchObject({
      calendarStart: "2026-09-03", calendarEnd: "2026-09-04", targetLabel: "전체 학생",
    });
    const otherFeed = await listStudentNotices(otherStudent);
    expect(otherFeed.notices.some((notice) => notice.id === globalId)).toBe(true);
    expect(otherFeed.notices.some((notice) => notice.id === classId || notice.id === teamId)).toBe(false);
    await expect(markNoticeRead(otherStudent, teamId)).rejects.toThrow("찾지 못했습니다");

    await markNoticeRead(teamStudent, globalId);
    expect((await listStudentNotices(teamStudent)).notices.find((notice) => notice.id === globalId)?.isRead).toBe(true);
    await updateAnnouncement(teacher, globalId, {
      title: "전체 수업 안내 수정", content: "변경된 준비 사항을 다시 확인하세요.", audienceType: "all",
      priority: "important", calendarStart: "2026-09-05", calendarEnd: null,
    });
    expect((await listStudentNotices(teamStudent)).notices.find((notice) => notice.id === globalId)).toMatchObject({ isRead: false, calendarStart: "2026-09-05" });
    await setAnnouncementArchived(teacher, classId, true);
    expect((await listStudentNotices(teamStudent)).notices.some((notice) => notice.id === classId)).toBe(false);
    expect((await listTeacherAnnouncements(teacher)).some((notice) => notice.id === classId && notice.status === "archived")).toBe(true);
  });

  it("stores plan and report feedback as team action requests until resolved", async () => {
    const db = await getDb();
    await reviewPlan("demo_plan_1", teacher.id, "feedback", "측정 횟수와 통제 변인을 보완하세요.", "9반 1조");
    let feed = await listStudentNotices(teamStudent);
    const planNotice = feed.notices.find((notice) => notice.title === "탐구 계획서 수정 요청");
    expect(planNotice).toMatchObject({ kind: "action_request", isResolved: false, priority: "important", actionPath: "/inquiry#plan" });
    expect(planNotice?.content).toContain("통제 변인");
    await markNoticeRead(teamStudent, planNotice!.id);
    feed = await listStudentNotices(teamStudent);
    expect(feed.actionRequiredCount).toBeGreaterThanOrEqual(1);
    expect(feed.notices.find((notice) => notice.id === planNotice!.id)?.isRead).toBe(true);
    await db.query(
      "UPDATE investigation_plans SET form_data = $1 WHERE id = 'demo_plan_1'",
      [JSON.stringify({ field: "화학", topic: "시험 탐구", motivation: "궁금증", purpose: "비교", method: "반복 측정", expectedResult: "차이 확인" })],
    );
    await submitPlan("demo_plan_1", teamStudent.id);
    expect((await listStudentNotices(teamStudent)).notices.find((notice) => notice.id === planNotice!.id)?.isResolved).toBe(true);

    await db.query("UPDATE reports SET status = 'submitted' WHERE id = 'report_demo_session_1'");
    await reviewReport("report_demo_session_1", teacher.id, "feedback", "결과와 결론의 연결을 보완하세요.");
    const reportNotice = (await listStudentNotices(teamStudent)).notices.find((notice) => notice.title === "팀 최종보고서 수정 요청");
    expect(reportNotice).toMatchObject({ isResolved: false, actionPath: "/inquiry#report" });
    expect(reportNotice?.content).toContain("결과와 결론");
  });
});
