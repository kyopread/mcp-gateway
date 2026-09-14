# MCP Gateway 로드맵

현재 저장소는 **1단계까지 구현된 상태**입니다. 아래 순서는 운영 배포를 준비하면서 위험이 큰 영역부터 검증하도록 정리했습니다.

## 완료: 1단계 — 단일 Gateway와 기본 보안

- stdio·Streamable HTTP MCP 연결
- 서버별 도구 namespace와 도구 목록 통합
- Keycloak JWT 서명, issuer, audience, scope, 역할 검증
- 서버·도구별 role/scope 정책과 사용자·그룹 allow/deny
- 외부 MCP API key, Bearer, client credentials 연결
- 요청 제한, 타임아웃, upstream 세션 분리, 감사 기록
- 웹 콘솔, PKCE 로그인, MCP·사용자·그룹·감사 메뉴

완료 기준: `npm run check`, `npm run test:ui`, `npm audit --omit=dev --audit-level=high` 통과.

## 2단계 — 운영 배포 검증

목표는 실제 Keycloak과 한 개 외부 MCP를 연결한 단일 인스턴스 운영입니다.

- 운영 도메인과 TLS reverse proxy 구성
- Keycloak realm/client/scope/audience를 운영 주소로 변경
- 콘솔 관리자와 일반 사용자 계정으로 로그인·로그아웃 검증
- 외부 MCP 서비스 계정 secret 주입과 연결 실패 처리 검증
- SQLite 영속 볼륨, 백업·복구, 파일 권한 점검
- 부하 테스트: 동시 호출, rate limit, upstream timeout, 종료 중 요청
- 침투 테스트: 위조 JWT, 잘못된 audience, Host/Origin, 권한 우회, SSRF 시도

완료 기준: 실제 환경에서 관리자·일반 사용자·그룹별 허용/차단 시나리오와 복구 절차를 기록하고, 운영 체크리스트를 승인.

## 3단계 — 상태 관리와 관측성 강화

단일 인스턴스의 운영 한계를 넘을 필요가 생길 때 진행합니다.

- PostgreSQL 등 외부 DB로 정책·그룹·감사 저장소 이전
- 다중 replica의 정책 변경 이벤트와 MCP catalog 동기화
- Redis 기반 전역 rate limit과 짧은 TTL 캐시
- OpenTelemetry trace, 메트릭, 알림 대시보드
- upstream별 상태·지연·실패율과 `/ready` 의존성 점검
- 감사 로그 장기 보관, 검색, 보존 기간 정책

완료 기준: replica 장애·재시작·동시 관리자 변경에서도 권한 결정과 catalog가 일관되고, SLO 대시보드에서 원인을 추적.

## 4단계 — 권한 모델 확장

현재의 Gateway 그룹과 Keycloak 역할 모델로 부족할 때 진행합니다.

- Keycloak 그룹 계층 또는 외부 디렉터리 동기화
- 사용자별 외부 MCP OAuth 연결과 refresh token vault
- token exchange 또는 upstream별 사용자 위임 토큰
- Keycloak UMA/PDP와 도구별 세밀한 정책
- 승인·만료·4-eyes 권한 변경 workflow

완료 기준: 사용자의 외부 데이터 권한이 서비스 계정과 분리되고, 토큰 보관·철회·감사 정책이 검토를 통과.

## 5단계 — MCP 기능 범위 확장

tools 외 기능이 제품 요구사항이 될 때 진행합니다.

- prompts와 resources 전달
- subscriptions, sampling, elicitation
- 장시간 작업과 취소·재개 상태 관리
- upstream capabilities 변경 자동 갱신
- MCP 클라이언트별 연결 진단 화면

완료 기준: 각 기능별 protocol conformance 테스트와 권한·감사 정책이 함께 통과.

## 진행 원칙

1. 2단계 운영 검증을 통과하기 전에는 고가용성 기능을 추가하지 않습니다.
2. 사용자별 외부 OAuth는 보안 모델과 token vault를 먼저 결정한 뒤 구현합니다.
3. 모든 권한 변경은 deny 우선, 즉시 반영, 감사 기록 원칙을 유지합니다.
4. 새 MCP 기능은 protocol 테스트와 권한 우회 테스트를 함께 추가합니다.
