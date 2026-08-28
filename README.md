# 과학과제연구 팀 탐구 플랫폼

2026학년도 고등학교 1학년 과학과제연구 수업용 웹 플랫폼입니다. 현재 프로토타입은 8월 31일 첫 수업에 필요한 팀 편성, AI 주제 탐색, 공동 탐구 계획서, 교사 승인, 준비물 신청에 집중합니다.

## 현재 구현된 기능

- 학번 로그인, 최초 비밀번호 변경, 교사 비밀번호 초기화
- Excel 학생 명단 가져오기와 일회성 임시 비밀번호 카드 인쇄
- 교사의 팀 생성·배정·제거·팀장 지정(제거된 학생의 과거 자료는 보존)
- 팀 단위 AI 주제 탐색과 순차 대화 잠금
- 실제 학교 양식 항목을 반영한 공동 계획서, 항목 잠금, 자동 저장, 제출·승인·수정 요청
- 반별 Google Sheets 탭으로 보내는 준비물 신청과 5만 원 초과 확인 표시
- 교사용 팀 상세 화면에서 계획서, AI 대화, 준비물 동기화 상태 확인
- 작성자와 교사만 보는 차시별 개인 실험 일지, 사진 첨부, 오프라인 임시 저장·재전송

최종 보고서 공동 편집, 동료 평가, 맞춤 시험지·스캔 채점은 후속 단계입니다.

## 로컬 실행

1. `.env.example`을 참고하여 `.env.local`에 비밀값을 설정합니다.
2. `pnpm install`
3. `pnpm dev`
4. 브라우저에서 `http://localhost:3000`을 엽니다.

개발 모드에는 확인용 계정이 있습니다.

- 교사: `teacher` / `teacher1234`
- 학생: `10901` / `student1234`

개발 모드의 기본 데이터베이스는 메모리용이어서 서버를 재시작하면 초기화됩니다. 실제 수업에는 반드시 PostgreSQL `DATABASE_URL`을 연결해야 하며, 운영 모드는 영구 데이터베이스가 없으면 시작하지 않도록 막혀 있습니다.

Cloud Run에서는 Cloud SQL의 Unix 소켓을 사용합니다. `INSTANCE_UNIX_SOCKET`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`을 설정하면 `DATABASE_URL` 없이도 영구 PostgreSQL에 연결됩니다. 연결 풀은 작은 수업용 인스턴스의 연결 수를 보호하도록 컨테이너당 최대 5개로 제한합니다.

## Google Sheets 연결

로컬에서는 서비스 계정 JSON을 프로젝트 루트의 `service-account-google.json`으로 두고 다음을 `.env.local`에 설정합니다.

```text
GOOGLE_APPLICATION_CREDENTIALS=C:\Users\user\Desktop\Science qury platfrom\service-account-google.json
GOOGLE_SPREADSHEET_ID=1Ia5xoZZDv3b4sVq3la8POFNE_QVHEuLhitS-YC_QBVg
```

준비물 시트를 JSON의 `client_email` 주소와 공유하고 편집자 권한을 부여해야 합니다. JSON은 Git과 Docker 이미지에서 제외됩니다. Cloud Run에서는 키 파일 대신 실행 서비스 계정에 시트 편집 권한을 부여합니다.

## OpenAI 연결

`OPENAI_API_KEY`는 브라우저 코드에 포함되지 않고 서버에서만 사용합니다. 팀 ID는 해시된 안전 식별자로 보내며, AI 프롬프트에는 실명과 학번 대신 `팀원 A` 같은 가명만 전달합니다. API 키가 있어도 별도의 API 결제/사용 한도가 준비되어야 합니다. ChatGPT 구독과 API 결제는 별개입니다.

## 운영 전 필수값

- `DATABASE_URL` 또는 `INSTANCE_UNIX_SOCKET`과 `DB_USER`, `DB_PASSWORD`, `DB_NAME`: 영구 PostgreSQL 연결
- `SESSION_SECRET`: 32자 이상의 무작위 문자열
- `OPENAI_API_KEY`: 서버 비밀값
- `BOOTSTRAP_TEACHER_PASSWORD`: 최초 교사 비밀번호
- Google Cloud 실행 서비스 계정 또는 로컬 Google 서비스 계정 JSON

## 확인 명령

```text
pnpm typecheck
pnpm test
pnpm build
```
