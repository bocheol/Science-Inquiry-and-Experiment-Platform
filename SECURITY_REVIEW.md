# 보안 감사와 남은 조치

2026-09-09 / 후속 66차. 현재 작업본 대상이며 운영 침해 조사나 전체 안전 인증이 아니다.

## 67차 보안 패치 현황

66차 설치 실패는 Node에서 기존 SheetJS CDN 인증서 체인을 신뢰하지 못한 오류(SELF_SIGNED_CERT_IN_CHAIN)로 분리됐다. 같은 다운로드를 `node --use-system-ca`로 실행하면 성공했다. 이 옵션으로 시스템 신뢰 저장소를 사용하되 인증서 검증은 유지했고, 전역 설정/공급망 규칙은 바꾸지 않았다.

로컬 Next.js를 16.3.3으로 갱신하고 pnpm-workspace.yaml에 `next>sharp: 0.35.4`를 고정했다. Dockerfile의 의존성 설치 단계에도 workspace 파일을 복사해 같은 고정 설정을 적용한다. 설치 스크립트는 실행하지 않았다. 기존 SheetJS 0.20.3 고정은 유지한다.

최종 전체 90개 파일·520개 검사(full-tests-67.log), 타입 포함 49개 경로 빌드(build-67.log), 변경 파일 공백 검사 통과. 운영 배포와 실제 외부 서비스 호출은 하지 않았다. 입력·오류 처리 항목은 여전히 다음 구현 대상으로 남는다.

291개 의존성 재감사는 알려진 권고 0건을 반환했다(dependency-audit-67.json). 실제 런타임은 Next 16.3.3/sharp 0.35.4이고 합성 2×2 PNG 생성도 성공했다(dependency-runtime-67.json). 별도 폴더에서 세 설치 설정 파일을 복사한 frozen-lockfile/offline/lockfile-only 검사도 통과했다(frozen-lock-67.log). 이는 Linux 컨테이너 전체 빌드/실행이나 운영 반영을 대신하지 않는다. 아래 66차 미완료 기록은 패치 전 이력이다.

## 의존성 감사

잠금 파일 전체를 `pnpm audit --json`으로 조회했다. 첫 제한 환경 조회는 fetch failed였고, 네트워크 허용 조회는 정상 감사 결과를 반환했다. 전체 291개 의존성에 대해 critical 2건/high 1건이며 세 권고가 서로 독립적인 세 공격 경로라는 뜻은 아니다. Next 이미지 권고와 sharp 권고는 관련된 하위 라이브러리 문제다.

| 패키지 | 현재 | 감사 결과 / 수정 버전 | 현재 판단 |
|---|---|---|---|
| Next.js | 16.3.2 | Windows 서버 원격 코드 실행, 16.3.3 이상 | Windows 로컬 실행 환경에 해당 조건이 있다. 운영 Dockerfile은 Linux Alpine이므로 Windows 조건과 구분한다. 실제 운영 이미지 재확인은 하지 않았다. |
| Next.js | 16.3.2 | AVIF 이미지 최적화 원격 코드 실행, 16.3.3 이상 | 악성 이미지로 시험하지 않는다. 공식 수정 버전으로 갱신한다. 앱 화면에서 Image 사용이 적다는 이유만으로 프레임워크 경로 전체를 안전 판정하지 않는다. |
| sharp | 0.35.3 (next의 선택 의존성) | libheif 관련 high, 0.35.4 이상 | 잠금 파일과 실제 설치 버전을 함께 올려 재감사한다. Next 16.3.3의 sharp 범위는 ^0.35.3이므로 Next만 갱신해 하위 버전이 그대로 남지 않는지 확인해야 한다. |

공식 근거: [Next Windows 권고](https://github.com/vercel/next.js/security/advisories/GHSA-p293-qw3h-jr36), [Next 이미지 권고](https://github.com/vercel/next.js/security/advisories/GHSA-2xp9-vwfh-vxw4), [sharp 권고](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c), [Next 16.3.3 릴리스](https://github.com/vercel/next.js/releases/tag/v16.3.3).

증거: `output/test-infra/dependency-audit-66-online.json`. 감사 서버가 아는 공지의 범위이며 외부 URL로 고정한 SheetJS 패키지, 운영 OS 패키지 및 알려지지 않은 결함까지 보증하지 않는다. 기존 SheetJS 0.20.3 고정/입력 제한은 유지한다.

### 설치 시도와 미완료 상태

설치 스크립트를 끄고 Next 16.3.3 갱신을 시도했다. 최초는 기존 .pnpm-store와 기본 저장소 불일치였다. 기존 저장소를 지정한 이후에도 fetch failed로 중단됐다. 캐시 우선 및 프로젝트 Node 실행기로 동일 pnpm을 실행해도 같았다. 공식 Next tarball과 기존 SheetJS tarball의 별도 HEAD 요청은 모두 HTTP 200이므로 인터넷 전체 단절로 단정하지 않는다. 패키지 관리자의 실제 다운로드 실패 원인을 더 분리해야 한다.

`dependency-update-66*.log`에 실패를 기록했다. package.json/잠금 파일의 Next 16.3.2와 실제 설치 16.3.2는 유지되며 **보안 패치 완료가 아니다**. 다음은 다운로드 경로 진단 → Next/선택 sharp 갱신 → 설치/잠금 버전 대조 → 재감사 → 전체 회귀/빌드다. 공급망 검사나 인증서 검증을 끄지 않는다. 새 보안 버전 검증 전 Windows 서버를 외부에 새로 공개하는 작업은 하지 않는다. 운영 반영은 별도 승인/배포 조건을 따른다.

## 입력과 오류 처리

### 72차 비AI 오류 비노출 완료

준비물·일지·푸시·공지·계정·팀·동아리 설정·회차·건의·도움말·PDF 경로는 UserFacingError 또는 기존의 명시 오류 클래스만 화면에 통과시킨다. 일반 DB/외부 서비스 Error의 원문은 경로별 재시도 안내로 바꾼다. Google Sheets의 응답 원문과 내부 연결 정보도 준비물 sync_error에 저장하지 않고 안전한 연결 확인 안내만 보존한다.

준비물·일지·푸시 집중 15개 파일·89개와 최종 전체 95개 파일·534개, 타입 포함 49개 경로 빌드가 통과했다(non-ai-errors-71.log, full-tests-72.log, build-72.log). `security-surface-72.json`에서 API 44개 직접 request.json 0개/일반 Error.message 반환 후보 0개다. 이는 정적 패턴과 합성 회귀 범위의 결과이며 호출 그래프 전체, 운영 Linux 이미지, 실제 외부 응답, 알려지지 않은 결함까지 인증하지 않는다.

### 70차 문서 오류 비노출

학생 계획서·보고서의 저장·제출·항목 잠금과 교사 검토·복원은 UserFacingError로 명시한 충돌·권한·회차·제출본 안내만 응답한다. 예상하지 못한 일반 Error는 메시지를 버리고 안전한 재시도 안내를 반환한다. FormWriteConflict도 UserFacingError를 상속한다. 합성 DB 연결 문자열과 비밀값이 응답에 포함되지 않고, 다른 팀원 작성 중 안내는 그대로 유지됨을 검증했다(document-errors-70.log).

전체 95개 파일·532개와 타입 포함 49개 경로 빌드가 통과했다(full-tests-70.log, build-70.log). 정적 목록은 `security-surface-70.json`이며 일반 Error.message 후보가 26개에서 19개로 줄었다. 이는 문서 관련 경로를 완료한 결과이며 준비물·공지·계정/팀·동아리 설정 등 남은 후보 전체를 완료했다는 뜻은 아니다.

66차 최초 정적 실행에서 API route 44개 중 직접 JSON 읽기 33개, 일반 Error.message 사용 후보 26개를 기록했다. 68차 현재 목록은 `security-surface-68.json`이며 직접 request.json 0개/일반 오류 후보 26개다. 정규식 후보 목록과 소스 해시이며 완전한 호출 그래프나 취약점 개수는 아니다.

### 68차 JSON 본문 제한

공통 readJsonBody는 1MiB 이하만 읽는다. Content-Length가 없거나 실제보다 작아도 스트림의 실제 바이트를 세고 초과 즉시 취소한다. 비정상 Content-Length, 잘못된 JSON, 유효하지 않은 UTF-8도 파싱 결과를 반환하지 않는다. 33개 API의 42개 직접 파싱을 모두 이 함수로 전환했고, 인증 거절은 본문을 읽기 전에 유지한다. 기존 API별 Zod 검사와 사용자 입력 안내는 유지하며 명단 multipart의 2MiB 제한은 별개다.

전체 Route Handler 직접 request.json 0건을 검사하는 회귀, 실제 청크 초과 취소, 선언 초과 시 추가 읽기 없음/취소, 정상 유니코드 및 시험 생성 경로를 검증했다(request-body-route-68.log). 전체 93개 파일·528개/타입 포함 49개 경로 빌드 통과(full-tests-68.log, build-68.log). 너무 큰 JSON은 각 경로의 기존 400 입력 안내로 거절하며 별도 413 문구는 두지 않았다. 내부 오류 문구 구분은 다음 항목으로 남는다.

### 69차 AI 오류 비노출

AI 관련 경로는 알려진 OpenAI 상태 또는 UserFacingError로 명시한 권한·회차·준비·재시도 안내만 표시한다. 일반 Error는 메시지 내용을 버리고 안전한 재시도 안내를 반환한다. 학생 회차 분석 판단 저장도 같은 userFacingMessage를 사용한다. 합성 DB 연결 문자열과 비밀값이 응답에 포함되지 않고, 명시한 회차 변경 안내는 유지됨을 검증했다(ai-error-safety-69.log). 전체 94개 파일·530개/49개 경로 빌드 통과(full-tests-69.log, build-69.log).

이 규칙은 AI 관련 서비스와 학생 회차 판단에 적용한 범위다. 아래의 비AI 후보 26개 전체를 완료한 것은 아니다.

- 명단 업로드는 Content-Length뿐 아니라 실제 스트림 크기를 제한하고 RosterInputError 외에는 일반 문구를 반환한다.
- 일반 JSON 경로의 파싱 전 실제 바이트 제한은 68차에 적용했다. next.config의 serverActions.bodySizeLimit를 Route Handler 제한 근거로 사용하지 않는다.
- 예: 학생 계획서 PATCH/POST는 DB 조회·서비스 예외를 일반 Error.message로 반환한다. 서비스의 정상 충돌 안내도 같은 Error를 사용한다. 내부 예외는 일반 문구로 바꾸되 사용자가 글을 보존하고 재시도할 수 있는 충돌 안내는 명시적인 사용자용 오류로 유지해야 한다.
- userFacingAiError도 알려진 공급자 상태 외 일반 Error.message를 반환한다. 이름만으로 안전한 정제 함수라고 간주하지 않는다. 실제 AI 호출 없이 합성 비밀값/DB 오류를 주입해 노출을 검사한다.
- 일부 시험·평가 경로는 request.json()의 형식 오류가 catch 밖에 있다. 잘못된 JSON은 안전한 400으로 처리하고, 인증 거절이 본문 읽기보다 먼저 유지되는지도 검증한다.

다음 구현은 명시적 사용자용 오류 구분을 적용하되, 각 서비스의 기존 권한/충돌/확정 기록 규칙을 보존한다. 입력 제한은 68차에 완료했고 오류 구분 및 실행 검증은 아직 하지 않았다.
