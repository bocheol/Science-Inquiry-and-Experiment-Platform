export function getStudentStageAccess(planStatus: string, hasMaterialRequest: boolean) {
  const planApproved = planStatus === "approved";
  return {
    journalAvailable: planApproved && hasMaterialRequest,
    journalLockedMessage: !planApproved
      ? "실험 일지는 탐구 계획서를 제출하고 선생님의 승인을 받은 뒤 열립니다."
      : !hasMaterialRequest
        ? "실험 일지는 준비물 신청을 한 번 완료한 뒤 열립니다. 준비물 신청 탭에서 먼저 제출해 주세요."
        : null,
    reportAvailable: planApproved,
    reportLockedMessage: planApproved
      ? null
      : "팀 보고서는 탐구 계획서를 제출하고 선생님의 승인을 받은 뒤 열립니다.",
  };
}
