# 단일 인스턴스 운영 검증

## SQLite 백업·복구

Node.js 22.17 이상에서 먼저 `npm run build`를 실행합니다. Gateway와 같은 OS 사용자로 실행하고, 목적지는 아직 존재하지 않는 파일을 지정합니다.

```sh
npm run db:backup -- data/gateway.sqlite backups/gateway-2026-09-15.sqlite
npm run db:restore -- backups/gateway-2026-09-15.sqlite data/restored-2026-09-15.sqlite
```

백업은 SQLite online backup API로 실행 중인 WAL 데이터까지 일관된 스냅샷으로 저장합니다. 두 명령 모두 무결성, 스키마 버전, 필수 테이블, 외래 키와 권한 대상 참조를 검사합니다. 성공하면 `status: verified`를 출력합니다. 기존 목적지 또는 SQLite sidecar가 있으면 실패하며, 기존 DB를 덮어쓰지 않습니다. 새 파일 권한은 `0600`입니다. 목적지 경로는 Gateway에서 동시에 열지 않는 전용 경로를 사용하세요.

실제 복구 적용 순서:

1. 위 복구 명령으로 새 DB 파일을 만듭니다.
2. Gateway 프로세스를 정상 종료합니다.
3. 설정의 `console.databasePath`를 복구된 파일 경로로 변경합니다.
4. Gateway를 시작하고 사용자·그룹·허용/거부 권한과 감사 기록을 확인합니다.
5. 실패하면 Gateway를 종료하고 이전 DB 경로로 설정을 되돌린 뒤 시작합니다.

백업에는 사용자 정보와 감사 기록이 포함됩니다. 접근을 제한한 별도 저장소에 복사하고 조직의 암호화·보존 정책을 적용하세요. 설정 파일, 환경 변수의 upstream secret, Keycloak DB는 이 백업에 포함되지 않으므로 별도로 보관해야 합니다. 파일 기반 MCP 설정은 재시작 시 다시 적용됩니다. 원본 `.sqlite` 파일만 복사하는 방식은 실행 중인 WAL 변경을 누락할 수 있습니다.

## 실제 Keycloak 로컬 검증

Java 21과 **새로 압축을 해제한 일회용 Keycloak 26.7.3 배포판**이 필요합니다. 기존 Keycloak 설치 경로를 지정하지 마세요. 스크립트는 해당 설치의 `data/import`에 테스트 realm을 만들고 로컬 DB를 생성합니다. 포트 8180·3200을 비워 두세요.

```sh
npm run build
KEYCLOAK_HOME=/absolute/path/to/fresh/keycloak-26.7.3 node examples/keycloak-native-check.mjs
```

임의로 생성한 테스트 secret을 자식 프로세스 환경에 전달하고 실제 Keycloak과 Gateway를 시작합니다. 검증 종료 시 두 프로세스와 임시 Gateway DB를 정리합니다. Keycloak 배포 디렉터리는 남으므로 실행 후 일회용 디렉터리를 삭제하세요. 재실행에는 새 배포 디렉터리를 사용합니다.

검증 범위: 실제 서명 토큰, 인증 없는 요청 거부, reader의 도구 목록 필터, 허용 도구 호출, admin 전용 도구 거부, 디렉터리 서비스 계정의 사용자 조회. 실패하면 종료 코드 1을 반환합니다. 브라우저 PKCE 로그인·로그아웃과 운영 TLS 환경은 별도 검증이 필요합니다.

2026-09-15 로컬 검증 결과: Java 21 + Keycloak 26.7.3에서 위 스크립트 통과. `npm run check`에서 타입 검사·27개 테스트·웹/서버 빌드 통과. WAL 백업 복원 후 그룹 허용보다 사용자 거부가 우선하는 권한 결정과 감사 기록 보존을 확인했습니다.

## 운영 환경에서 남은 작업

- Gateway 도메인/TLS와 Keycloak issuer·audience·callback·logout 주소를 확정합니다.
- 실제 관리자·일반 사용자 로그인과 사용자·그룹 권한 시나리오를 검증합니다.
- 실제 외부 MCP의 서비스 계정 secret과 연결 실패 처리를 검증합니다.
- 영속 볼륨에서 정기 백업과 복구 훈련, 부하·종료·보안 검증 결과를 기록합니다.

로컬 테스트 통과만으로 운영 배포 검증 완료를 의미하지 않습니다.
