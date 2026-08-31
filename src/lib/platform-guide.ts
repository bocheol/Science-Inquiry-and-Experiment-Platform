type GuideEntry = { title: string; keywords: string[]; answer: string };

export const PLATFORM_GUIDE_ENTRIES: GuideEntry[] = [
  { title: "개인정보·권한 보호", keywords: ["개인정보", "학생 자료", "학생 기록", "비밀번호", "대신 변경", "대신 삭제"], answer: "도움말은 학생 개인정보·비밀번호·학생 작성 자료를 조회하거나 외부 AI에 전달하지 않으며, 어떤 학생 자료도 대신 변경·삭제하지 않습니다. 필요한 처리는 교사가 해당 관리 화면에서 권한과 대상을 직접 확인한 뒤 수행해야 합니다." },
  { title: "학생 최초 로그인", keywords: ["학생", "로그인", "최초", "임시", "비밀번호", "변경"], answer: "학생은 5자리 학번과 배부받은 임시 비밀번호로 로그인한 뒤, 첫 화면에서 8자 이상이며 글자와 숫자가 포함된 본인 비밀번호로 변경합니다." },
  { title: "학생 비밀번호 초기화", keywords: ["비밀번호", "분실", "초기화", "재발급"], answer: "교사 대시보드의 학생 명단에서 해당 학생의 비밀번호 초기화를 실행합니다. 새 임시 비밀번호는 학생에게 직접 전달하고 문서나 메신저에 장기 보관하지 마세요." },
  { title: "학생 개별 추가·비활성화", keywords: ["학생", "추가", "전입", "누락", "삭제", "제거", "비활성", "복원"], answer: "교사 대시보드에서 5자리 학번과 이름으로 학생을 개별 추가할 수 있습니다. 학생 계정 제거는 과거 기록을 지우지 않는 비활성화로 처리하며, 비활성 학생 목록에서 복원할 수 있습니다. 복원한 학생은 팀에 자동 재배정되지 않으므로 필요한 팀을 다시 선택하세요." },
  { title: "팀 편성·팀장 지정", keywords: ["팀", "편성", "배정", "이동", "제거", "팀장"], answer: "교사 대시보드에서 학급을 고른 뒤 팀을 만들고 학생을 배정합니다. 팀 이동·제거 이력은 보존되며, 현재 팀원 중 한 명을 팀장으로 지정할 수 있습니다." },
  { title: "AI 이론 탐구", keywords: ["ai", "이론", "대화", "주제", "관심사", "탐구"], answer: "학생 팀이 관심사를 입력하면 탐구 방향 3개를 받고 하나를 선택해 팀 공유 대화를 이어갑니다. AI는 완성 답안을 대신 쓰지 않고 질문·힌트·출처 중심으로 돕습니다." },
  { title: "탐구 계획서 승인", keywords: ["계획서", "제출", "승인", "피드백", "재승인"], answer: "학생 팀이 계획서를 제출하면 교사가 팀 상세 화면에서 승인하거나 수정 요청합니다. 승인 뒤 내용이 바뀌면 재승인 필요 상태가 됩니다." },
  { title: "계획서·보고서 복원", keywords: ["이력", "복원", "되돌리기", "계획서", "보고서"], answer: "계획서와 보고서의 변경 이력에서 이전 상태를 확인할 수 있습니다. 복원은 교사와 해당 팀의 현재 팀장만 할 수 있고, 복원 뒤에는 다시 제출·검토 절차를 거칩니다." },
  { title: "준비물 신청", keywords: ["준비물", "시트", "구글", "예산", "5만원", "재전송", "모바일", "링크"], answer: "학생이 준비물 탭에서 품목을 제출하면 해당 학급 Google Sheet에 반영됩니다. 모바일 쇼핑 앱의 공유 문구를 붙여넣으면 지원 쇼핑몰은 PC 링크로 정리되며, 변환할 수 없는 모바일 전용 링크는 PC 웹 주소를 다시 복사하도록 안내합니다. 5만원을 넘으면 경고가 표시되고, 연동 실패 건은 교사 화면에서 재전송할 수 있습니다." },
  { title: "개인 실험 일지", keywords: ["일지", "사진", "오프라인", "차시"], answer: "계획 승인 후 학생별 일지를 작성합니다. 일지와 사진은 작성자와 교사만 볼 수 있으며, 잠시 연결이 끊기면 브라우저에 보존했다가 다시 전송합니다." },
  { title: "팀 최종보고서", keywords: ["보고서", "공동", "역할", "제출", "수정"], answer: "팀원은 학교 양식 순서대로 보고서 항목과 역할을 공동 작성합니다. 같은 항목은 한 번에 한 명이 편집하며, 교사는 제출된 보고서를 확인 완료하거나 수정 요청합니다." },
  { title: "시험 관리", keywords: ["시험", "문항", "pdf", "채점", "결과"], answer: "교사는 공통·팀 공통·개인화 문항 수를 정해 초안을 생성하고, 검토·수정 후 확정해야 PDF를 출력할 수 있습니다. 채점과 결과 공개도 교사가 직접 실행합니다." },
  { title: "자기·동료평가", keywords: ["자기평가", "동료평가", "평가", "익명", "의견", "공개"], answer: "교사가 학급 평가를 열면 학생은 행동 기준 4단계로 자기·동료평가를 제출합니다. 익명 의견은 교사 검토 뒤 공개되며, 항목별 유효 평가 3건 미만이면 평균과 개별 의견 대신 교사 종합 피드백만 제공합니다." },
  { title: "진척 확인·내보내기", keywords: ["진척", "대시보드", "엑셀", "csv", "내보내기"], answer: "교사 대시보드에서 학급·팀별 진행 상태와 확인할 일을 볼 수 있습니다. Excel/CSV 내보내기에는 일지 본문·사진·비밀번호가 포함되지 않습니다." },
];

export function answerPlatformGuideQuestion(rawQuestion: string) {
  const question = rawQuestion.trim();
  if (!question || question.length > 500) throw new Error("질문은 1~500자로 입력해 주세요.");
  const normalized = question.toLocaleLowerCase("ko-KR");
  const protectedDataRequest = /(학생|특정|개인).*(개인정보|비밀번호|자료|기록).*(읽|보여|알려|전달|변경|바꿔|삭제)|(?:비밀번호|학생 자료|학생 기록).*(읽|보여|알려|전달|변경|바꿔|삭제)/i.test(normalized);
  if (protectedDataRequest) {
    const entry = PLATFORM_GUIDE_ENTRIES[0]!;
    return { answer: `${entry.title}: ${entry.answer}`, sources: [entry.title] };
  }
  const scored = PLATFORM_GUIDE_ENTRIES.map((entry) => ({
    entry,
    score: entry.keywords.reduce((score, keyword) => score + (normalized.includes(keyword.toLocaleLowerCase("ko-KR")) ? 1 : 0), 0),
  })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title, "ko"));
  if (!scored.length) {
    return {
      answer: "현재 공식 사용 안내에서 이 질문에 해당하는 내용을 찾지 못했습니다. 교사 대시보드의 기능 이름을 포함해 다시 질문하거나 운영 담당 교사에게 확인해 주세요.",
      sources: [] as string[],
    };
  }
  const selected = scored.slice(0, 2).map((item) => item.entry);
  return {
    answer: selected.map((entry) => `${entry.title}: ${entry.answer}`).join("\n\n"),
    sources: selected.map((entry) => entry.title),
  };
}
