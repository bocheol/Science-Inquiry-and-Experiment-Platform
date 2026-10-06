# 과학탐구실험 학생 UI 실험판

별도 GPT Sites 프론트엔드입니다. 기존 `bocheol/Science-Inquiry-and-Experiment-Platform`의 Cloud Run, PostgreSQL, 학생 로그인, 팀·회차·권한·저장 로직을 유지합니다. 기존 운영 프론트엔드를 교체하거나 학생 데이터를 Sites로 옮기지 않습니다.

## 현재 동작

- 학생·교사 화면 체험: 합성 데이터만 사용합니다. 재접속/새로고침하면 초기화됩니다.
- 학생 MVP: 홈, 주제·핵심 질문, 고정 코칭 예시, 대화 기록, 서버 양식 계획서 편집, 임시저장·제출, 사진 첨부 활동 일지.
- 교사 요약: 일반 교과 반·팀·대화 수·일지 수. 동아리 관리와 관리자 쓰기는 기존 플랫폼에서 사용합니다.
- 운영 연결: 서버 상태 GET 확인만 제공합니다. 생산 서버를 쓰기 가능한 staging 모드로 지정하면 거부합니다.
- 유료 AI 호출은 서버 중계에서 항상 차단합니다. 연결 대상 원본에서 학생별 크레딧/월 $25 상한/영구 토큰·비용 원장이 확인되지 않았기 때문입니다.
- PDF AI 분석, 일반·정밀·종합 모드는 기존 저장소 API에 없어 구현 완료로 표시하지 않습니다.

## 두 프론트가 같은 서버를 이용하는 방법

브라우저는 같은 출처의 `/api/bridge/*`를 호출합니다. Sites Worker는 고정 허용 목록의 기존 API만 중계하며, 기존 `science_inquiry_session` 서명 쿠키만 전달합니다. 학생 비밀번호 검증·세션 버전·학년도·팀 소속·계획서 충돌 검사·제출 검증은 기존 백엔드가 수행합니다. ChatGPT 사이트 접근 권한과 학생 로그인은 별개입니다.

백엔드 브랜치의 두 **새 읽기 API** `/api/sites/session`, `/api/sites/teacher-summary`는 `SITES_PILOT_ENABLED=true`를 별도 테스트 서버에 설정해야 동작합니다. 기본값은 비활성입니다. production에는 배포하지 않았습니다.

## 안전한 설정

`.env.example`에는 값 없는 예시만 제공합니다. 실제 런타임 변수는 Sites 환경 설정에 넣습니다.

| 변수 | 의미 |
|---|---|
| PILOT_BACKEND_ORIGIN | 경로 없는 HTTPS 서버 출처. 로컬 IP·인증정보·쿼리·리디렉션 금지 |
| PILOT_BACKEND_MODE | 기본 `production-readonly`; 별도 DB를 갖춘 테스트 서버에만 `staging` |
| PILOT_ALLOW_WRITES | 기본 `no`; 테스트 서버에만 `yes` |

DB URL, DB 비밀번호, SESSION_SECRET, OpenAI 키는 이 프론트에 넣지 않습니다. 사이트 자체 D1/R2 바인딩도 없습니다. 화면 초안은 메모리에만 있고 학생 데이터 캐시·localStorage 저장을 하지 않습니다. 새로고침 전 서버 저장 여부를 확인해야 합니다.

## 중계 경계

동일 출처 Origin 확인, 위조 신원 헤더 제거, 세션 쿠키 HttpOnly/Secure/SameSite=Strict 재발급, 요청 JSON 64KiB/사진 multipart 6MiB, 응답 2MiB, 35초 타임아웃, 자동 재시도 없음, Worker 인스턴스당 진행 요청 8개 제한을 적용합니다. 이 제한은 전체 서비스 분산 rate limit이 아닙니다. 300명 운영 보장은 실제 테스트 서버 부하 시험 이후 결정합니다.

사진은 기존 일지 API를 사용합니다. 기존 백엔드는 JPG/PNG/WebP 5MB×5장이지만 실험판은 Worker 메모리 한도를 고려해 **1장, 5MB**만 허용합니다. 사진은 기존 PostgreSQL의 학생 일지 저장 흐름으로 보내며, Sites에 저장하지 않습니다. PDF 분석용 범용 upload endpoint는 없습니다.

## 개발 및 검사

```bash
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
node --experimental-strip-types tests/bridge.mts
pnpm build
```

WebMCP는 지원하는 document.modelContext 환경에서 학생 화면 이동 도구만 등록합니다. 로그인·저장·유료 AI 호출을 대신 수행하지 않습니다. 지원 브라우저에서의 검증은 아직 수행하지 않았습니다.

## 확장 단계

1. 교사 합성 화면 확인 및 독립 staging DB/서버 구성
2. 합성 계정으로 로그인·비밀번호 변경·팀 권한·서버 저장·제출·이미지 왕복 확인
3. 월 예산 원장과 크레딧 예약/정산/환급, 모델 가격표, 전역 제한을 기존 서버에 구현·검증한 뒤 AI 중계 잠금 해제
4. 5–10명 → 30명 → 300명. 기존 화면을 계속 유지하고 실패 시 기존 화면으로 복귀

GitHub 브랜치의 `experiments/sites-student-ui`가 이 UI의 소스 사본입니다. 배포 전에는 Sites와 GitHub 두 소스의 차이를 비교합니다.

## GitHub 자산 보존

글꼴은 Pretendard 1.3.9의 버전 고정 공개 패키지에서 가져오는 빌드 의존성입니다. `asset-source/fonts.json`에 URL·크기·SHA-256을 기록했고 prebuild가 검증해 `public/fonts`에 저장합니다. 처음 복원할 때 네트워크가 필요하며 검증된 로컬 파일은 재사용합니다. `node scripts/restore-fonts.mjs`로 개발 전에 수동 복원할 수 있습니다. 게시된 Sites의 글꼴 바이너리와 GitHub 빌드 의존성의 bytes는 다릅니다. 원래 게시 자산은 위 Sites 원본 Git 커밋에 남습니다. 화면·중계·API 로직은 게시 소스와 같고 생성 파일은 제외합니다.
