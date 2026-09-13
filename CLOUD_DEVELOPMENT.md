# 클라우드 개발 작업실

이 설정은 GitHub Codespaces에서 최신 소스를 수정하고 휴대폰·태블릿으로 미리보기 화면을 확인하기 위한 것이다. 학생과 교사가 사용하는 기존 Cloud Run·Cloud SQL은 그대로 운영한다.

## 처음 연결하기

1. 최신 로컬 작업의 백업·민감 파일 제외·검증을 끝낸 뒤 GitHub에 최종 소스를 저장한다. 예전 GitHub 버전으로 작업실을 먼저 만들지 않는다.
2. GitHub 저장소에서 **Code → Codespaces → Create codespace**를 선택한다. `.devcontainer/devcontainer.json` 설정을 사용한다.
3. 설치 완료 후 터미널에 `pnpm dev`를 입력한다.
4. **Ports → 3000 → Open in Browser**로 미리보기를 연다. 공개 범위는 **Private**로 유지한다.
5. 휴대폰·태블릿에서도 같은 GitHub 계정으로 로그인한 뒤 그 미리보기 주소를 연다.

처음 설치할 때 Node 24, pnpm 11.19.0, PostgreSQL 16, 한글 PDF 글꼴을 준비하고 잠금 파일에 고정된 패키지를 설치한다. 로컬 PC에 Docker를 설치할 필요는 없다.

## 개발용 로그인

실제 교사·학생 계정을 사용하지 않는다. 빈 개발 DB에서만 아래 합성 계정이 생성된다.

| 역할 | 아이디 | 개발용 비밀번호 |
|---|---|---|
| 교사·마스터 | `teacher2` | `development-teacher-only` |
| 예시 학생 | `10901`, `10902`, `10903` | `student1234` |

이 값은 공개된 개발 예시이며 실제 수업 계정에 사용하지 않는다. 이미 만들어진 개발 계정의 비밀번호를 초기화 과정에서 덮어쓰지 않는다.

## 데이터와 외부 연결

- 개발 DB는 작업실 안의 `science_dev`다. 포트를 외부에 공개하지 않는다. 운영 DB 주소나 Cloud SQL 소켓을 넣으면 개발 실행기가 거절한다.
- 개발 데이터는 전용 Docker 볼륨에 보관한다. 서버 재시작 때 지워지지 않지만, Codespace 삭제나 볼륨 삭제 뒤 복구를 보장하지 않는다. 중요한 소스는 검증 후 GitHub에 저장한다.
- 운영 `.env.local`, 서비스 계정 파일, 학생 명단·사진·로그인 배부 자료, DB 백업을 Codespaces에 복사하지 않는다.
- 개발 실행기는 로컬 환경 파일보다 우선하는 설정으로 운영 DB·Google Sheets·푸시·예약 호출을 끈다. 기본 상태에서는 실제 AI도 꺼져 있으며 AI 답변 성공까지 검증한 것으로 간주하지 않는다.
- 실제 AI 검수가 필요하면 승인된 기존 키를 GitHub의 **Codespaces secret** `SCIENCE_DEV_OPENAI_API_KEY`로 이 저장소에만 연결하고 개발 서버를 다시 실행한다. 값은 채팅·소스·터미널 명령에 붙이지 않는다. 실제 AI에는 합성 자료만 사용한다. `cloud:check`는 이 키가 있어도 사용하지 않는다.
- Google Sheet·실제 푸시 검증은 별도 시험 자원과 명시된 대상이 준비된 경우에만 수행한다.

## 평소 작업 순서

### 태블릿에서 Codex에 개발 지시하기

작업실에는 Codex CLI 0.154.0을 함께 설치한다. Codespaces의 터미널에서 `codex login --device-auth`를 실행하고 안내된 공식 ChatGPT 페이지에서 본인 계정으로 로그인한다. 이 인증은 플랫폼이 학생에게 AI 답변을 제공할 때 쓰는 API 키와 별개다. 기기 코드 로그인을 사용할 수 없다면 [공식 인증 안내](https://learn.chatgpt.com/docs/auth)를 따른다. 로그인 정보는 Git에 저장하지 않는다.

로그인 후 프로젝트 폴더에서 다음 명령으로 Astra·High를 선택해 시작한다.

“Codex용 장치 코드 인증을 활성화” 안내가 나오면 [ChatGPT 보안 및 로그인 설정](https://chatgpt.com/#settings/Security)의 아래쪽에서 **Codex용 장치 코드 인증 활성화**를 켠다. 위쪽의 개발자 모드와는 별개다. 설정을 켠 뒤 터미널에서 진행 중인 로그인 명령을 취소하고 `codex login --device-auth`를 다시 실행해 새 코드로 연결한다. 일회용 코드는 해당 공식 인증 페이지에서만 입력하며 문서나 Git에 저장하지 않는다.

```bash
codex -m gpt-6-astra -c 'model_reasoning_effort="high"'
```

그 안에 원하는 수정 내용을 한국어로 입력한다. 미리보기 서버는 별도 터미널에서 `pnpm dev`로 실행한다. 이 데스크톱 대화와 Codespaces의 Codex 대화는 별개이므로 `PROJECT_STATUS.md`와 `CURRENT_DECISIONS.md`로 작업 상태를 이어받는다. ChatGPT Work에서 이야기한 내용이 실행 중인 Codespace에 자동 전달되는 것으로 가정하지 않는다. [Codex CLI 안내](https://learn.chatgpt.com/docs/cli)

요청 전달 → 수정 → `pnpm cloud:check` → 미리보기 확인 → GitHub에 저장 → 검토된 변경의 운영 배포 순서다. GitHub에 저장하는 것만으로 운영 사이트가 바뀌지는 않는다. 이번 자동 검증에는 운영 배포 작업이나 배포 자격정보가 없다.

`pnpm cloud:check`는 환경 격리 검사, 기존 전체 자동 테스트, 운영 빌드, 타입 검사를 순서대로 실행한다. GitHub Actions도 같은 검사를 실행한다. 테스트 데이터를 운영 DB에 넣지 않는다.

클라우드 작업실은 사용을 마치면 **Stop codespace**로 중지한다. 사용량·저장공간 요금과 계정 한도는 생성 화면에서 확인한다. 삭제 전에는 저장하지 않은 소스와 필요한 개발 데이터를 먼저 보존한다.

## 다시 열었을 때

- 미리보기 서버가 응답하지 않으면 먼저 기존 실행 터미널과 3000번 포트를 확인한다. 서버가 종료된 경우 `/workspaces/science-inquiry`에서 `node scripts/cloud-dev.mjs dev`로 실행할 수 있다. 이는 `pnpm dev`와 같은 개발 실행기이며 운영 연결 차단을 유지한다. 다른 경로에서 패키지 전체 재설치 안내가 나타나면 바로 승인하지 말고 기존 작업 폴더를 확인한다.

- 작업실 열기 → `pnpm cloud:status` → `pnpm dev`.
- 새 설정을 받은 경우 **Codespaces: Rebuild Container**로 설치 구성을 갱신한다.
- 개발 미리보기는 작업실과 개발 서버가 실행되는 동안 사용할 수 있다. 상시 운영 주소와 구분한다.
- 한글 PDF 글꼴은 `PDF_FONT_PATH`에 설정돼 있다. 다른 Linux 환경에서는 이 경로가 실제 설치된 글꼴과 일치하는지 확인한다.
- 최신 진행·검증 결과는 `PROJECT_STATUS.md`의 최상단 기록을 우선한다. 과거 기능 설명의 미구현 표기는 현재 상태 증거가 아니다.

## 구성 참고

- [GitHub Codespaces Node 프로젝트 설정](https://docs.github.com/en/codespaces/setting-up-your-project-for-codespaces/adding-a-dev-container-configuration/setting-up-your-nodejs-project-for-codespaces)
- [미리보기 포트와 접근 범위](https://docs.github.com/en/codespaces/developing-in-a-codespace/forwarding-ports-in-your-codespace)
- [Codespaces 비밀값 관리](https://docs.github.com/en/codespaces/managing-your-codespaces/managing-your-account-specific-secrets-for-github-codespaces)
