# Keycloak 연동

`config/local.json`의 기본 issuer는 `http://127.0.0.1:8080/realms/mcp-gateway`입니다.
Gateway는 `${issuer}/protocol/openid-connect/certs`의 JWKS를 이용합니다.
서명 기본 알고리즘은 RS256이며 issuer, audience, exp, iat, sub, nbf와 `typ=Bearer`를 검사합니다.
ID token은 MCP/API 인증에 사용할 수 없습니다. 시간 오차는 5초까지 허용합니다.

## 제공되는 client

| Client              | 용도                                                               |
| ------------------- | ------------------------------------------------------------------ |
| `mcp-gateway`       | API/MCP resource의 역할 네임스페이스: reader, admin, gateway-admin |
| `mcp-console`       | 웹 콘솔 public client, Authorization Code + PKCE S256              |
| `mcp-local-client`  | 별도 MCP 클라이언트 연동 예제                                      |
| `gateway-smoke`     | 실제 토큰 발급·MCP 호출 검증용 reader 서비스 계정                  |
| `gateway-directory` | 사용자 목록 읽기 전용 서비스 계정                                  |

`gateway-directory`는 realm-management의 view-users, query-users 역할을 사용합니다.
Gateway 프로세스에 `KEYCLOAK_DIRECTORY_SECRET`을 전달하고 `console.directory`를 설정해야
웹의 Keycloak 동기화가 동작합니다. 그룹은 Gateway에 보관하며 Keycloak 그룹을 동기화하지 않습니다.

콘솔 관리자 `console-admin`의 최초 비밀번호는 환경변수로 import하고 첫 로그인에 변경합니다.
그 외 사용자는 Keycloak에서 생성합니다. 일반 사용자에게 `gateway-admin` 역할을 부여하지 마세요.

## 기존 Keycloak에 연결

1. `auth.issuer`와 `auth.clientId`를 실제 realm/resource client로 설정합니다.
2. `mcp:access` scope의 audience mapper에 외부 Gateway `publicUrl`을 넣습니다.
3. `mcp-console` public client에 정확한 callback, Web Origin, logout URI를 등록합니다.
4. 콘솔 운영자에게 resource client의 `gateway-admin` 역할을 부여합니다.
5. 사용자 동기화를 쓰면 읽기 전용 directory client와 secret을 등록합니다.

로컬 콘솔 callback은 `http://127.0.0.1:3000/auth/callback`, Web Origin은
`http://127.0.0.1:3000`, logout URI는 `http://127.0.0.1:3000/`입니다.
운영 시 세 곳을 HTTPS 공개 origin으로 바꿉니다. 와일드카드 callback을 사용하지 않습니다.

access token에는 `aud=publicUrl`, `scope`의 `mcp:access`,
`resource_access.<auth.clientId>.roles`가 있어야 합니다.
`client:reader`는 이 client의 reader 역할, `realm:reader`는 realm 역할을 의미하며 서로 다릅니다.

`keycloak-js`가 브라우저 PKCE·state·nonce와 토큰 갱신을 처리합니다.
access/refresh token은 브라우저 메모리에만 보관하고 localStorage에 저장하지 않습니다.
페이지를 다시 불러오면 로그인 버튼을 다시 누를 수 있으며 Keycloak 세션이 있으면 재인증됩니다.
Gateway는 사용자의 로그인 비밀번호를 받거나 저장하지 않습니다.

Compose realm import는 이미 존재하는 realm을 갱신하지 않습니다.
기존 설치에는 관리 화면에서 client·scope·역할을 추가하거나 승인된 마이그레이션을 적용하세요.
데이터 볼륨을 삭제해 초기화하는 절차는 제공하지 않습니다.

## 토큰 철회와 접근 변경

Gateway 사용자·그룹 권한은 매 요청 DB에서 읽으므로 즉시 반영됩니다.
Keycloak role·로그아웃·계정 비활성화는 이미 발급된 JWT에 즉시 반영되지 않습니다.
샘플 access token TTL은 300초입니다. 즉시 Keycloak 토큰 철회가 필요한 환경에는
introspection 또는 폐기 목록을 추가해야 합니다. 현재 버전은 이를 구현하지 않았습니다.

## 공식 문서

- [MCP Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [Keycloak OIDC](https://www.keycloak.org/securing-apps/oidc-layers)
- [Keycloak JavaScript adapter](https://www.keycloak.org/securing-apps/javascript-adapter)
- [Keycloak realm import](https://www.keycloak.org/server/importExport)
