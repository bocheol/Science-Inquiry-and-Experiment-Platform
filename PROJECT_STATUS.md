# 과탐실 AI 탐구 플랫폼 - 현재 상태 및 인수인계

## 2026-10-05 별도 GPT Sites 학생 UI · 운영 보존 실험 브랜치

- 사용자가 과탐실은 기존 backend/DB/auth를 유지하고 새 Sites UI만 추가하도록 지시했습니다. 기준 HEAD bf456bceae36186f1a0fb7e408776361506c7689를 조사했고 Cloud Run production·PostgreSQL 데이터/스키마·기존 학생 계정·AI 서비스는 변경하지 않았습니다.
- SITES_PILOT_ENABLED opt-in 최소 프로필/교사 집계 GET API와 6검사를 추가했습니다. 기본 404이며 기존 인증을 재사용합니다. experiments/sites-student-ui에 실제 Sites UI 소스를 보존합니다. 별도 비공개 사이트 https://science-inquiry-backend-pilot.qhcjf2.chatgpt.site 를 게시했습니다.
- 합성 화면 MVP는 로그인 체험·홈·주제/질문·고정 코칭·대화·계획서 저장/제출·사진 첨부 일지·교사 요약입니다. 운영 서버는 health/read 확인만 하고 쓰기 및 유료 AI는 중계에서 잠깁니다. 서버 크레딧·월 $25 상한·PDF AI 업로드·세 가지 모드가 이 원본에는 없으므로 구현 완료로 표시하지 않습니다.
- 검증: TypeScript, 전체 112파일 612검사, Next 프로덕션 빌드 통과. 첫 시험 PDF 글꼴 누락 실패 2개는 PDF_FONT_PATH 설정 후 코드 변경 없이 모두 해결했습니다. Sites TypeScript/Vinext, 중계 보안·응답 경계·동시 합성 60요청(8진행/52제한), 실제 Worker SSR/글꼴/서버 변수/쓰기 잠금 통과. production health 직접 GET 200. 로컬 Worker의 외부 DNS 제한으로 로컬 중계 health는 502였으나 게시된 Sites 중계에서는 health 200/비로그인 inquiry 403/운영 login 423을 확인했습니다. 실제 학생 계정·운영 DB 쓰기·유료 AI·실기기 브라우저/WebMCP 검증은 미실시입니다.
- 새 프로필/교사 API는 별도 GitHub 브랜치에만 보존하며 운영 반영하지 않습니다. 독립 staging 구성과 서버 비용 원장 후 5–10명→30명→300명 단계별 확인이 필요합니다. 기존 화면은 계속 유지합니다. docs/SITES_PILOT_AUDIT.md, SITES_API_CONTRACT.md, 300_USER_REVIEW.md를 참조합니다.

## 과거 이력의 보존

기존 Git 커밋 이력은 유지합니다. 현재 상태 문서를 업데이트하며 과거 운영 기록에 있던 실명·비공개 시트 주소·자격증명 파일 참조를 새 업로드 내용에서 제외했습니다. 학생 데이터베이스·대화·제출본·계정은 변경하지 않았습니다. 과거 코드 기준 커밋은 `bf456bceae36186f1a0fb7e408776361506c7689`입니다.
