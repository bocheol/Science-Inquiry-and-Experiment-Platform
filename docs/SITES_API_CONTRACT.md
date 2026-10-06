# Sites 프론트와 기존 서버 API 계약

범용 `/api/login` 등 새 이름을 기존 이름으로 추정하지 않습니다. 실제 API를 다음처럼 유한 중계합니다. 모든 학생 쓰기는 기존 서버의 현재 세션·팀 소속·회차·권한 검사로 결정됩니다.

| Sites action | 기존 API | 계약 |
|---|---|---|
| health | GET /api/health | DB SELECT 1 상태 |
| login | POST /api/auth/login | loginId,password → Set-Cookie, destination |
| session | GET /api/sites/session | 이번 브랜치 신규. 최소 프로필, mustChangePassword |
| password | POST /api/auth/change-password | newPassword → 세션 버전 갱신 |
| logout | POST /api/auth/logout | 기존 세션 삭제. 303은 중계에서 안전한 JSON으로 변환 |
| inquiry | GET /api/inquiry?team | 팀·회차·대화·서버 양식·계획서 |
| topic | POST /api/inquiry/topic-select | cycleId,sessionId,planId,topic,expectedTopic |
| topics | POST /api/inquiry/topic-suggestions | 유료 AI: 현재 항상 잠금 |
| chat | POST /api/inquiry/messages | content,sessionId,cycleId,requestId. 현재 항상 잠금 |
| lock | POST /api/inquiry/plan/lock | fieldKey,planId,cycleId,action acquire/release |
| plan | PATCH /api/inquiry/plan | fieldKey,value,expectedValue,planId,cycleId |
| plan | POST /api/inquiry/plan | action submit,planId,cycleId. restore는 UI 미노출 |
| journals | GET/POST /api/inquiry/journals | 학생 일지 조회 및 multipart 사진 저장 |
| teacher | GET /api/sites/teacher-summary | 이번 브랜치 신규. 교사 전용, 일반 교과 집계 |

서명 세션을 브라우저 JavaScript로 노출하지 않습니다. 중계가 전달하는 것은 지정된 science_inquiry_session 쿠키뿐이며 oai/Authorization 임의 헤더를 버립니다. 서버 출처는 런타임 환경변수로 고정하며 브라우저가 URL을 지정하지 않습니다. CORS를 광범위하게 열지 않고, 브라우저→Sites는 같은 출처, Sites Worker→기존 서버는 서버 통신입니다.

운영 출처는 `production-readonly`만 허용합니다. 모든 POST/PATCH는 423이며 login도 잠깁니다. 별도 HTTPS staging 출처 + PILOT_ALLOW_WRITES=yes에서만 인증/계획서/일지 쓰기를 시험할 수 있습니다. 유료 AI는 staging에서도 잠깁니다.

계획서는 서버 필드 id/kind/options/required를 사용합니다. 지원하지 않는 table 등의 값은 읽기만 하고 원본을 유지하며 기존 화면에서 편집하도록 안내합니다. 저장 실패 시 메모리 초안을 유지하고 서버 성공 후에만 저장 완료를 표시합니다. 중계는 요청을 자동 재시도하지 않습니다.

## 아직 없는 API 계층

학생별 credits/usage, 전체 월 비용 예산, 기능별 토큰·가격 원장, PDF AI 첨부 계층은 새 UI의 이름만 만들어 해결하지 않습니다. 후속 서버 작업에서 DB 영구 원장과 권한·예약/정산/환급·중복 요청 방지를 먼저 구현하고, API가 실제 통제할 때만 프론트 토글을 엽니다.
