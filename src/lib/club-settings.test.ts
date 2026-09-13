import { describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { assignClubStudent, createClub, createClubTeam, enrollClubStudent } from "@/lib/clubs";
import { createClubConfigDraft, getClubSettingsData, publishClubConfig, setClubTeacherAssignment, updateClubConfigDraft } from "@/lib/club-settings";
import { getInquiryDataForTeam } from "@/lib/inquiry-data";
import { getCustomTabResponse, reviewCustomTabResponse, saveCustomTabResponse } from "@/lib/club-custom-tabs";

describe("club setting versions and permissions", () => {
  it("keeps published versions immutable and blocks unassigned teachers", async () => {
    const db = await getDb();
    await db.query("UPDATE users SET is_master = TRUE, must_change_password = FALSE WHERE id = 'teacher_bootstrap'");
    const clubId = await createClub("teacher_bootstrap", "설정시험동아리");
    const draftId = await createClubConfigDraft("teacher_bootstrap", { clubId, configType: "plan" });
    const initial = await getClubSettingsData("teacher_bootstrap");
    const draft = initial.clubs.find((club) => club.id === clubId)!.versions.find((version) => version.id === draftId)!;
    await updateClubConfigDraft("teacher_bootstrap", { versionId: draftId, title: "설정시험 계획서", definition: draft.definition, expectedRevision: draft.revision });
    await publishClubConfig("teacher_bootstrap", draftId, "설정시험동아리");
    await expect(updateClubConfigDraft("teacher_bootstrap", { versionId: draftId, title: "수정 불가", definition: draft.definition, expectedRevision: draft.revision + 1 })).rejects.toThrow("수정할 수 없습니다");

    await db.query("INSERT INTO users (id, name, login_id, academic_year, role, password_hash, must_change_password) VALUES ('club_setting_other_teacher', '다른교사', 'club-setting-other', 2026, 'teacher', 'unused', FALSE)");
    await expect(createClubConfigDraft("club_setting_other_teacher", { clubId, configType: "report" })).rejects.toThrow("권한이 없습니다");
    await setClubTeacherAssignment("teacher_bootstrap", clubId, "club_setting_other_teacher", true);
    await expect(createClubConfigDraft("club_setting_other_teacher", { clubId, configType: "report" })).resolves.toBeTruthy();
  });

  it("rejects unsafe Google Sheet publication settings", async () => {
    const data = await getClubSettingsData("teacher_bootstrap");
    const club = data.clubs.find((item) => item.name === "설정시험동아리")!;
    const draftId = await createClubConfigDraft("teacher_bootstrap", { clubId: club.id, configType: "materials" });
    const refreshed = await getClubSettingsData("teacher_bootstrap");
    const draft = refreshed.clubs.find((item) => item.id === club.id)!.versions.find((item) => item.id === draftId)!;
    await expect(updateClubConfigDraft("teacher_bootstrap", {
      versionId: draftId, title: draft.title, expectedRevision: draft.revision,
      definition: { ...draft.definition, sheet: { mode: "existing", spreadsheetUrl: "not-a-sheet", sheetName: "운영", testSheetName: "시험" } },
    })).rejects.toThrow("Google Sheet 주소");
    await updateClubConfigDraft("teacher_bootstrap", {
      versionId: draftId, title: draft.title, expectedRevision: draft.revision,
      definition: { ...draft.definition, sheet: { mode: "existing", spreadsheetUrl: "https://docs.google.com/spreadsheets/d/test-sheet-id/edit", sheetName: "운영", testSheetName: "시험", columnMapping: {} } },
    });
    await expect(publishClubConfig("teacher_bootstrap", draftId, "설정시험동아리")).rejects.toThrow("품명·단가·개수·링크 열");
    await updateClubConfigDraft("teacher_bootstrap", {
      versionId: draftId, title: draft.title, expectedRevision: draft.revision + 1,
      definition: { ...draft.definition, sheet: { mode: "existing", spreadsheetUrl: "https://docs.google.com/spreadsheets/d/test-sheet-id/edit", sheetName: "석지우, 우수인, 홍린, 안현주", testSheetName: "양식", layout: "team_sections", headerRow: 3, columnMapping: {} } },
    });
    await expect(publishClubConfig("teacher_bootstrap", draftId, "설정시험동아리")).rejects.toThrow("별도의 빈 탭");
  });

  it("pins published document settings to a new team and serves a no-code custom tab", async () => {
    const clubId = await createClub("teacher_bootstrap", "버전고정동아리");
    const planDraftId = await createClubConfigDraft("teacher_bootstrap", { clubId, configType: "plan" });
    const customDraftId = await createClubConfigDraft("teacher_bootstrap", { clubId, configType: "custom_tab", title: "관찰 기록" });
    const data = await getClubSettingsData("teacher_bootstrap");
    const club = data.clubs.find((item) => item.id === clubId)!;
    const planDraft = club.versions.find((item) => item.id === planDraftId)!;
    const customDraft = club.versions.find((item) => item.id === customDraftId)!;
    await updateClubConfigDraft("teacher_bootstrap", {
      versionId: planDraftId, title: "간단 계획", expectedRevision: planDraft.revision,
      definition: { description: "동아리 전용", fields: [{ id: "topic", label: "우리 주제", kind: "short_text", required: true }] },
    });
    await updateClubConfigDraft("teacher_bootstrap", {
      versionId: customDraftId, title: "관찰 기록", expectedRevision: customDraft.revision,
      definition: { description: "매회 기록", responseMode: "team", workflow: "review", fields: [{ id: "observation", label: "관찰", kind: "long_text", required: true }] },
    });
    await publishClubConfig("teacher_bootstrap", planDraftId, "버전고정동아리");
    await publishClubConfig("teacher_bootstrap", customDraftId, "버전고정동아리");
    const teamId = await createClubTeam("teacher_bootstrap", clubId, "기록팀");
    const student = await enrollClubStudent("teacher_bootstrap", clubId, "10901", "");
    await assignClubStudent("teacher_bootstrap", clubId, student.studentId, teamId, true);
    const inquiry = (await getInquiryDataForTeam(teamId))!;
    expect(inquiry.plan).toMatchObject({ configVersionId: planDraftId, description: "동아리 전용" });
    expect(inquiry.plan.fields.map((field) => field.label)).toEqual(["우리 주제"]);
    expect(inquiry.customTabs.map((tab) => tab.title)).toContain("관찰 기록");
    await saveCustomTabResponse(student.studentId, { sessionId: inquiry.session.id, configVersionId: customDraftId, responseData: { observation: "색이 천천히 변했다." }, submit: true });
    await expect(getCustomTabResponse(student.studentId, inquiry.session.id, customDraftId)).resolves.toMatchObject({ responseData: { observation: "색이 천천히 변했다." }, status: "submitted" });
    const reviewData = await getClubSettingsData("teacher_bootstrap");
    const response = reviewData.clubs.find((item) => item.id === clubId)!.customResponses[0]!;
    await reviewCustomTabResponse("teacher_bootstrap", { responseId: response.id, teacherFeedback: "관찰의 시간 변화를 더 적어 주세요.", reviewed: true });
    await expect(getCustomTabResponse(student.studentId, inquiry.session.id, customDraftId)).resolves.toMatchObject({ status: "reviewed", teacherFeedback: "관찰의 시간 변화를 더 적어 주세요." });
  });
});
