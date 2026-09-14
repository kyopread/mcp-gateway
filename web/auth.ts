import Keycloak from 'keycloak-js';
export type LoginConfig = {
  mode: 'disabled' | 'keycloak';
  issuer: string | null;
  clientId: string;
  scope: string;
  publicUrl: string;
};
let client: Keycloak | undefined;
let config: LoginConfig;
export async function initialize() {
  const response = await fetch('/api/config');
  if (!response.ok)
    throw new Error('관리 콘솔 설정을 불러오지 못했습니다. 서버 설정을 확인해 주세요.');
  config = await response.json();
  if (config.mode === 'disabled')
    return { config, authenticated: sessionStorage.getItem('gateway-demo') === 'yes' };
  const marker = config.issuer!.lastIndexOf('/realms/');
  client = new Keycloak({
    url: config.issuer!.slice(0, marker),
    realm: decodeURIComponent(config.issuer!.slice(marker + 8)),
    clientId: config.clientId,
  });
  const authenticated = await client.init({
    pkceMethod: 'S256',
    checkLoginIframe: false,
    responseMode: 'query',
    scope: `openid ${config.scope}`,
    redirectUri: `${location.origin}/auth/callback`,
  });
  if (location.pathname === '/auth/callback') history.replaceState({}, '', '/');
  return { config, authenticated };
}
export async function login() {
  if (config.mode === 'disabled') {
    sessionStorage.setItem('gateway-demo', 'yes');
    location.assign('/');
    return;
  }
  await client!.login({
    redirectUri: `${location.origin}/auth/callback`,
    scope: `openid ${config.scope}`,
  });
}
export async function logout() {
  sessionStorage.removeItem('gateway-demo');
  if (client?.authenticated) await client.logout({ redirectUri: location.origin + '/' });
  else location.assign('/');
}
const messages: Record<string, string> = {
  admin_required: '관리자 권한이 필요합니다.',
  invalid_request: '입력한 값을 확인해 주세요.',
  server_connection_failed:
    '연결하지 못했습니다. URL, 등록된 자격 증명, 허용된 도메인을 확인해 주세요.',
  file_server_readonly: '이 서버의 연결 정보는 설정 파일에서 변경할 수 있습니다.',
  server_exists: '이미 사용 중인 서버 ID입니다.',
  group_exists: '같은 이름의 그룹이 있습니다.',
  directory_sync_failed:
    'Keycloak 사용자 동기화에 실패했습니다. 디렉터리 서비스 계정의 설정과 view-users 권한을 확인해 주세요.',
  rate_limit_exceeded: '요청이 많습니다. 60초 후 다시 시도해 주세요.',
  invalid_grants: '권한 목록이 변경되었습니다. 화면을 새로 고침하고 다시 저장해 주세요.',
};
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  if (client?.authenticated) {
    try {
      await client.updateToken(30);
    } catch {
      throw new Error('로그인 세션이 만료되었습니다. 로그아웃 후 다시 로그인해 주세요.');
    }
  }
  const response = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(client?.token ? { Authorization: `Bearer ${client.token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 204) return undefined as T;
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401)
      throw new Error('로그인 세션이 만료되었습니다. 로그아웃 후 다시 로그인해 주세요.');
    throw new Error(
      messages[data.error] ?? '요청을 처리하지 못했습니다. 입력값과 서버 상태를 확인해 주세요.',
    );
  }
  return data;
}
