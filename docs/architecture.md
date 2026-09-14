# 구조와 운영 범위

## 구성

| 경로                                                | 책임                                                        |
| --------------------------------------------------- | ----------------------------------------------------------- |
| `src/auth.ts`, `src/config.ts`                      | Keycloak JWT 검증, 역할/scope, 설정 검증                    |
| `src/store.ts`, `src/registry.ts`                   | SQLite 영속 데이터, 동적 MCP catalog, 실시간 접근 검사      |
| `src/console-api.ts`, `src/directory.ts`            | 관리자 API, 사용자·그룹·권한 관리, Keycloak 사용자 가져오기 |
| `src/gateway.ts`, `src/upstream.ts`, `src/index.ts` | MCP transport, 외부 자격 증명·세션, HTTP·종료 처리          |
| `web/`                                              | React 관리 콘솔, Keycloak 로그인, 반응형 화면               |

권한 결정: 활성 서버에서 사용자/그룹 deny가 하나라도 있으면 거부합니다.
그 외에는 사용자/그룹 allow 또는 파일의 role policy를 요구합니다.
도구에 지정된 role/scope policy는 추가 AND 조건입니다. 관리자는 별도로 권한을 부여받지 않으면
모든 도구를 자동 실행할 수 없습니다. 콘솔 관리 권한과 도구 실행 권한은 별개입니다.

## 관리 API

`GET /api/config`만 공개입니다. `/api/me`, `/api/servers`는 인증이 필요합니다.
나머지 관리자 API는 `console.adminRole`을 요구합니다.

| 리소스                  | 동작                                                                         |
| ----------------------- | ---------------------------------------------------------------------------- |
| `/api/servers`          | GET 목록, POST HTTP MCP 등록; `/:id` PUT/DELETE; `/:id/refresh` POST         |
| `/api/users`            | GET 목록, POST 기존 Keycloak subject 등록; `/api/directory/sync` POST 동기화 |
| `/api/groups`           | GET/POST, `/:id` PUT/DELETE; members는 실제 등록된 사용자 ID 배열            |
| `/api/grants/:kind/:id` | PUT으로 user/group의 직접 규칙 교체; effect는 allow/deny                     |
| `/api/audit`            | GET 최근 200개 감사 기록                                                     |

관리 UI는 비밀 값을 입력받지 않습니다. HTTP 자격 증명 참조는 운영자가 허용한 환경변수로 제한됩니다.
운영 중 외부 주소 등록은 `console.allowedUpstreamOrigins` allowlist로 제한합니다.
MCP 관리자는 도구 및 데이터 접근을 통제하는 높은 신뢰의 관리자입니다.
파일의 stdio 서버는 웹에서 생성·수정·삭제하지 못합니다. 그 접근 권한은 웹에서도 설정할 수 있습니다.

## 전송·연결

Gateway는 stateless Streamable HTTP POST입니다. 요청마다 클라이언트 인증을 확인합니다.
외부 호출마다 독립 MCP 연결을 생성해 upstream 세션 상태가 사용자 사이에 공유되지 않게 합니다.
HTTP 외부 세션은 가능하면 DELETE로 종료하고 로컬 stdio 프로세스도 닫습니다.

OAuth 서비스 토큰은 외부 서버별로 캐시하며 동시에 한 번만 발급 요청합니다.
만료 직전에 갱신하고 401 응답을 받으면 다음 요청을 위해 무효화합니다.
작업 부작용을 고려해 401·타임아웃·네트워크 오류가 난 도구를 자동 재호출하지 않습니다.
Gateway 사용자 Bearer token, Cookie, 임의 MCP `_meta`를 upstream으로 전달하지 않습니다.
외부 endpoint와 token endpoint redirect는 차단합니다.

등록/수정/연결 확인 시 실제 도구 목록을 읽습니다. 실패한 수정은 기존 연결 설정을 유지합니다.
UI의 “연결 확인됨”은 마지막 초기화·catalog 조회 성공이며 지속적인 생존 감시가 아닙니다.
활성 upstream 하나라도 시작 시 실패하면 Gateway 시작이 실패합니다.
실행 중 장애 후 다음 호출은 새 연결을 만들 수 있습니다. 목록 갱신은 연결 확인 버튼을 사용합니다.

## 운영 한도

| 항목    | 현재 구현                                                                             |
| ------- | ------------------------------------------------------------------------------------- |
| 데이터  | SQLite WAL, 단일 인스턴스; 설정/권한/그룹 변경을 다른 replica에 방송하지 않음         |
| 요청    | MCP 본문 1 MiB, IP당 120회/분, API 240회/분, MCP 동시 처리 50개 기본값                |
| 시간    | upstream 전체 deadline 기본 30초, HTTP 수신 15초, 헤더 수신 10초                      |
| Catalog | 서버당 최대 100페이지/10,000개 도구, 등록/연결 확인 시 조회                           |
| 감사    | DB 최근 10,000개 보관, UI 최근 200개 표시; 장기 보관은 로그 수집 파이프라인 별도 필요 |

Rate limit은 프로세스 메모리이며 전역 분산 제한이 아닙니다. 여러 replica는 공용 DB와
catalog/정책 동기화 및 전역 제한 설계가 필요합니다. 현재 구성으로 replica를 늘리지 마세요.
Node 22의 `node:sqlite`는 experimental 경고를 출력합니다. 필요한 SQL 기능만 사용하며
지원 Node 버전에서 테스트합니다. DB, WAL, SHM은 동일 영속 볼륨을 사용합니다.

로그는 JSON 요청 ID, 작업 subject, 도구 이름, 결과, 시간을 기록합니다.
토큰, secret, 도구 인자/결과 본문, upstream 오류 상세는 로그에 남기지 않습니다.
암호화된 로그 저장·백업·보관 기간은 배포 환경에서 설정해야 합니다.

`/health`는 프로세스 응답, `/ready`는 초기 catalog 준비 및 종료 상태만 나타냅니다.
Keycloak/upstream 현재 생존을 재검사하지 않습니다. 종료 시 진행 중 호출을 취소합니다.
타임아웃이나 취소는 외부에서 이미 실행한 작업을 롤백하지 않습니다.

## 미지원 범위

사용자별 외부 OAuth, refresh token vault, token exchange, Keycloak UMA/PDP,
Keycloak 그룹 동기화, prompts/resources 전달, sampling/elicitation, SSE 클라이언트 구독,
장시간 작업과 고가용성 클러스터는 구현하지 않았습니다.
외부 서비스 계정 자체의 데이터 권한은 사용자별로 분리되지 않습니다.

현재 기능과 테스트는 운영 기반을 제공하지만 실제 인프라에서의 부하·침투·복구 시험이나
실제 Keycloak 컨테이너 검증을 대신하지 않습니다. 배포용 Dockerfile과 로컬 Keycloak Compose는
별도이며 Compose의 개발 모드를 외부에 공개하지 않습니다.
