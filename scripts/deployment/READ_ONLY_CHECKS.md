# 운영 읽기 확인 절차 — 배포 명령 없음

이 문서는 운영 상태 조회만 다룹니다. 운영 배포·DB migration·트래픽 전환·복원·권한 부여 명령은 포함하지 않습니다. 현재 Work에서는 기존 Cloud/DB 인증 연결이 없어 이 절차를 실행하지 않았습니다.

## 필요한 기존 환경

- 이미 인증된 `gcloud`, `psql`, 해당 Cloud Run 서비스/리비전과 Cloud SQL 인스턴스·백업을 읽을 수 있는 기존 권한이 필요합니다. 로그인, 자격정보 발급, API 활성화, IAM·DB 권한 변경은 이 절차에 포함하지 않습니다.
- 기존에 허용된 직접 PostgreSQL TLS 연결을 사용합니다. `PGHOST`는 해당 Cloud SQL API의 현재 IP와 일치하는 단일 IP, `PGPORT`는 5432, `PGDATABASE`는 앱 DB 이름이어야 합니다. 기존 `PGUSER`와 비밀번호/인증서 설정을 재사용하며 값을 출력하지 않습니다. 이 문서에 비밀번호나 DSN을 붙여 넣지 마세요.
- 검사기는 Cloud SQL의 **인스턴스 전용 CA**를 읽어 그 인증서로 libpq 서버 검증을 강제합니다. 로컬 개발 DB, 프록시·소켓·서비스 파일·다중 호스트, 공유/사용자 관리 CA처럼 이 도구가 신원을 입증하지 못하는 연결은 차단합니다. 통과시키려고 네트워크·CA 모드·인증 설정을 바꾸지 않습니다.
- 앱의 실제 Cloud Run 리비전과 템플릿에 `INSTANCE_UNIX_SOCKET`·`DB_NAME` 및 Cloud SQL 볼륨이 명확히 연결되어 있어야 합니다. DB 대상이 비밀 참조 안에 숨겨져 있거나 다른 접속 방식이면 별도 읽기 검증 경로가 필요합니다. 이 도구는 비밀 참조를 임의로 해석하거나 읽지 않습니다.
- 검사 DB 역할에 이미 `pg_read_all_stats`의 유효한 권한 또는 슈퍼유저 가시성이 있어야 합니다. `track_activities`가 꺼져 있거나 다른 세션 상태가 가려져도 차단합니다. 권한이 없을 때 **0건을 안전하다고 처리하지 않으며 GRANT를 실행하지 않습니다.**

## 실행할 읽기 검사

저장소 밖 비공개 경로의 JSON에 다음 다섯 항목만 실제 대상으로 채웁니다. 예시는 실행 가능한 운영 대상이 아닙니다.

```json
{
  "project": "REPLACE_WITH_EXISTING_PROJECT",
  "region": "REPLACE_WITH_EXISTING_REGION",
  "service": "REPLACE_WITH_EXISTING_SERVICE",
  "sql_instance": "REPLACE_WITH_EXISTING_INSTANCE",
  "database_name": "REPLACE_WITH_EXISTING_DATABASE"
}
```

기존 인증 환경에서 검토한 소스의 다음 명령만 실행합니다. 출력 파일도 저장소 밖에 보관합니다.

```sh
umask 077
python scripts/deployment/integrated_executor.py --command inspect --plan /private/read-only-target.json > /private/read-only-observation.json
```

이 명령은 Cloud API GET과 PostgreSQL 읽기 전용 트랜잭션만 사용합니다. 배포 lease나 실행 상태 파일을 만들지 않습니다. Cloud SQL에서 받은 공개 CA 인증서를 임시 로컬 파일로 사용한 뒤 지웁니다. 인증서·비밀번호·환경변수 값·학생 자료·실행 중 쿼리 본문을 출력하지 않습니다.

성공 결과에서 다음을 확인합니다.

1. 실제 트래픽 리비전의 `serving_image`와 별도의 `template_image`, 실제 요청 제한시간.
2. `database_target`의 인스턴스 연결명·생성 시각·CA/IP 집합 지문과 앱 DB 이름. 이 값은 DB 검사·Cloud Run 연결·Cloud SQL 백업 대상을 묶으며 최종 계획에도 그대로 포함합니다.
3. migration 이름/checksum, 전체 통계 가시성, 현재 다른 트랜잭션·준비된 트랜잭션 수, 성공한 백업 목록. 현재 0건은 앞으로 새 쓰기가 시작되지 않는다는 보장이 아닙니다.

권한·인스턴스·CA·DB 설정·제한시간을 검증할 수 없으면 실패 메시지만 기록하고 중단합니다. 권한을 자동 부여하거나 다른 연결로 우회하지 않습니다. 앱 `/api/health`는 초기화/migration을 실행할 수 있어 이 읽기 절차에서 호출하지 않습니다.

## 이 결과로 확인되지 않는 것

실제 서버 Google 연결과 교사별 공유는 별도 읽기 확인입니다. 이미 허용된 서버 인증 문맥이 있을 때만 `google-readonly.mjs`의 metadata 검사를 검토하며, 학생 자료나 셀 내용은 읽지 않습니다. 세특 설정 테이블이 없는 운영 DB에서는 실행하지 않습니다. 업로드·공유 변경·유료 AI 호출은 이 읽기 절차에 포함하지 않습니다.

성공한 백업 목록은 복원 성공의 증거가 아닙니다. 실제 백업의 별도 승인된 기존 인스턴스 복원, 외부/예약/백그라운드 쓰기 중단, 공용 태블릿, 교사 계정 매핑, 최종 배포 결정은 별도 단계입니다.

서버 신원과 통계 가시성 기준은 [Cloud SQL CA 문서](https://docs.cloud.google.com/sql/docs/postgres/authorize-ssl), [libpq TLS 검증](https://www.postgresql.org/docs/16/libpq-ssl.html), [PostgreSQL 통계 접근 규칙](https://www.postgresql.org/docs/16/monitoring-stats.html)을 따릅니다.
