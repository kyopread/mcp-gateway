import React, { useEffect, useRef, useState, type ReactNode, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Blocks,
  Check,
  ChevronRight,
  CircleHelp,
  Copy,
  FolderKey,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Network,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings2,
  Shield,
  ShieldCheck,
  Users,
  X,
  Zap,
} from 'lucide-react';
import { api, initialize, login, logout, type LoginConfig } from './auth';
import './style.css';

type Me = {
  id: string;
  username: string;
  email: string;
  admin: boolean;
  publicUrl: string;
  roles: string[];
  groups: { id: string; name: string }[];
  directoryEnabled: boolean;
  credentialEnvs: string[];
  allowedUpstreamOrigins: string[];
};
type Auth = {
  type: string;
  header?: string;
  valueEnv?: string;
  tokenEnv?: string;
  tokenUrl?: string;
  clientId?: string;
  clientSecretEnv?: string;
  scopes?: string[];
  resource?: string;
};
type Policy = { anyRole?: string[]; allScopes?: string[]; allowAuthenticated?: boolean };
type Mcp = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  source: string;
  status: string;
  toolCount: number;
  toolNames: string[];
  transport: string;
  upstream?: {
    transport: string;
    url?: string;
    auth?: Auth;
    policy?: Policy;
    tools?: Record<string, Policy>;
  };
};
type Person = { id: string; username: string; email: string; enabled: boolean };
type Group = { id: string; name: string; description: string; members: string[] };
type Grant = {
  kind: 'user' | 'group';
  subjectId: string;
  serverId: string;
  effect: 'allow' | 'deny';
};
type Event = {
  id: number;
  at: string;
  actor: string;
  action: string;
  target: string;
  outcome: string;
};
type Data = {
  me: Me;
  servers: Mcp[];
  users: Person[];
  groups: Group[];
  grants: Grant[];
  events: Event[];
};
type Page = 'overview' | 'servers' | 'users' | 'groups' | 'audit';
const pages: { id: Page; title: string; icon: typeof Server }[] = [
  { id: 'overview', title: '대시보드', icon: LayoutDashboard },
  { id: 'servers', title: 'MCP 서버', icon: Blocks },
  { id: 'users', title: '사용자', icon: Users },
  { id: 'groups', title: '그룹', icon: FolderKey },
  { id: 'audit', title: '감사 기록', icon: Activity },
];
const date = (value: string) =>
  new Date(value).toLocaleString('ko-KR', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
const actionNames: Record<string, string> = {
  'server.create': 'MCP 서버 등록',
  'server.update': 'MCP 서버 수정',
  'server.delete': 'MCP 서버 삭제',
  'server.refresh': 'MCP 연결 확인',
  'user.register': '사용자 등록',
  'group.create': '그룹 생성',
  'group.update': '그룹 수정',
  'group.delete': '그룹 삭제',
  'directory.sync': 'Keycloak 동기화',
  'permissions.user.update': '사용자 권한 변경',
  'permissions.group.update': '그룹 권한 변경',
  'tool.call': '도구 호출',
};
function Badge({ children, tone = 'green' }: { children: ReactNode; tone?: string }) {
  return (
    <span className={`badge ${tone}`}>
      <span className="dot" />
      {children}
    </span>
  );
}
function Empty({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <Blocks size={32} />
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}
function Modal({
  title,
  subtitle,
  close,
  children,
}: {
  title: string;
  subtitle?: string;
  close: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current!;
    el.showModal();
    return () => el.close();
  }, []);
  return (
    <dialog ref={ref} className="modal" onCancel={close}>
      <div className="modal-header">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button type="button" className="icon-button" aria-label="닫기" onClick={close}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function Login({
  config,
  error,
  enter,
}: {
  config?: LoginConfig;
  error: string;
  enter: () => void;
}) {
  return (
    <div className="login-layout">
      <section className="login-brand">
        <div className="brand">
          <span className="brand-symbol">
            <Network size={23} />
          </span>
          MCP Gateway<span className="version">CONSOLE</span>
        </div>
        <div className="login-story">
          <span className="eyebrow">YOUR TOOLS. ONE GATEWAY.</span>
          <h1>
            모든 연결을 한곳에.
            <br />
            <span>접근은 더 안전하게.</span>
          </h1>
          <p>
            팀의 MCP 서버를 연결하고,
            <br />
            필요한 사람에게 필요한 도구만 허용하세요.
          </p>
          <div className="network-art" aria-hidden="true">
            <div className="art-node top">
              <Users size={23} />
              <span>People</span>
            </div>
            <div className="art-node left">
              <Blocks size={23} />
              <span>MCP</span>
            </div>
            <div className="art-center">
              <Network size={40} />
            </div>
            <div className="art-node right">
              <FolderKey size={23} />
              <span>Groups</span>
            </div>
            <div className="art-node bottom">
              <ShieldCheck size={23} />
              <span>Access</span>
            </div>
          </div>
        </div>
        <div className="login-foot">
          <ShieldCheck size={16} /> Keycloak 기반 인증 · 세밀한 접근 제어
        </div>
      </section>
      <section className="login-form">
        <div className="login-card">
          <span className="login-icon">
            <KeyRound size={25} />
          </span>
          <span className="eyebrow">WORKSPACE ACCESS</span>
          <h2>관리 콘솔에 로그인</h2>
          <p>조직 계정으로 안전하게 시작하세요.</p>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <button className="primary login-button" disabled={!config} onClick={enter}>
            {config?.mode === 'disabled' ? '로컬 데모 열기' : 'Keycloak으로 로그인'}
            <ArrowRight size={18} />
          </button>
          <div className="login-divider">
            <span />
            안전한 조직 인증
            <span />
          </div>
          <div className="login-note">
            <ShieldCheck size={19} />
            <p>
              {config?.mode === 'disabled'
                ? '현재는 로컬 개발 모드입니다. 실제 서비스에서는 Keycloak 인증이 필수입니다.'
                : '로그인은 Keycloak에서 진행합니다. 비밀번호는 Gateway에 저장되지 않습니다.'}
            </p>
          </div>
          <p className="login-help">접근 권한이 없나요? 조직 관리자에게 문의하세요.</p>
        </div>
        <span className="login-bottom">MCP Gateway · Workspace Console</span>
      </section>
    </div>
  );
}
function App() {
  const [config, setConfig] = useState<LoginConfig>();
  const [authenticated, setAuthenticated] = useState(false);
  const [data, setData] = useState<Data>();
  const [page, setPage] = useState<Page>('overview');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<ReactNode>(null);
  useEffect(() => {
    initialize()
      .then((result) => {
        setConfig(result.config);
        setAuthenticated(result.authenticated);
      })
      .catch(() =>
        setError('로그인 설정을 불러오지 못했습니다. Gateway와 Keycloak 설정을 확인해 주세요.'),
      );
  }, []);
  async function refresh() {
    const me = await api<Me>('/me');
    const [servers, users, groups, grants, events] = await Promise.all([
      api<Mcp[]>('/servers'),
      me.admin ? api<Person[]>('/users') : [],
      me.admin ? api<Group[]>('/groups') : [],
      me.admin ? api<Grant[]>('/grants') : [],
      me.admin ? api<Event[]>('/audit') : [],
    ]);
    setData({ me, servers, users, groups, grants, events });
  }
  useEffect(() => {
    if (authenticated) refresh().catch((err) => setError(err.message));
  }, [authenticated]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  async function perform(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError('');
    try {
      await action();
      await refresh();
      setToast(message);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function navigate(next: Page) {
    setPage(next);
    setQuery('');
    setError('');
  }
  const close = () => setModal(null);
  const saved = async (message: string) => {
    await refresh();
    close();
    setToast(message);
  };
  const openMcp = (server?: Mcp) =>
    setModal(<McpForm server={server} me={data!.me} close={close} saved={saved} />);
  const openGroup = (group?: Group) =>
    setModal(<GroupForm group={group} users={data!.users} close={close} saved={saved} />);
  const permissions = (
    kind: 'user' | 'group',
    subject: { id: string; name?: string; username?: string },
  ) =>
    setModal(
      <Permissions kind={kind} subject={subject} data={data!} close={close} saved={saved} />,
    );
  function confirmDelete(kind: 'servers' | 'groups', id: string, name: string) {
    setModal(
      <Confirm
        title={`${name} 삭제`}
        text="연결된 권한 설정도 함께 삭제됩니다. 이 작업을 진행할까요?"
        close={close}
        submit={async () => {
          await api(`/${kind}/${encodeURIComponent(id)}`, 'DELETE');
          await saved('삭제했습니다.');
        }}
      />,
    );
  }
  if (!authenticated)
    return (
      <Login
        config={config}
        error={error}
        enter={() =>
          login().catch(() =>
            setError('Keycloak에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.'),
          )
        }
      />
    );
  if (!data)
    return (
      <div className="loading">
        <Network size={36} />
        <h2>{error || '워크스페이스를 불러오는 중입니다'}</h2>
        {error && <button onClick={() => void logout()}>다시 로그인</button>}
      </div>
    );
  const visiblePages = pages.filter(
    (item) => data.me.admin || ['overview', 'servers'].includes(item.id),
  );
  const matches = (text: string) => text.toLowerCase().includes(query.toLowerCase());
  const servers = data.servers.filter((server) =>
    matches(`${server.name} ${server.description} ${server.id}`),
  );
  const users = data.users.filter((user) => matches(`${user.username} ${user.email}`));
  const groups = data.groups.filter((group) => matches(`${group.name} ${group.description}`));
  const copyEndpoint = () =>
    navigator.clipboard
      .writeText(data.me.publicUrl)
      .then(() => setToast('MCP 주소를 복사했습니다.'))
      .catch(() => setError('주소를 복사하지 못했습니다. 표시된 주소를 직접 복사해 주세요.'));
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigate('overview');
          }}
        >
          <span className="brand-symbol">
            <Network size={22} />
          </span>
          <div>
            MCP Gateway<small>WORKSPACE CONSOLE</small>
          </div>
        </a>
        <div className="workspace">
          <span className="workspace-avatar">W</span>
          <div>
            My Workspace
            <small>{config?.mode === 'disabled' ? '로컬 개발 환경' : 'Keycloak 연결'}</small>
          </div>
          <ShieldCheck size={16} />
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {visiblePages.map((item) => (
            <button
              key={item.id}
              aria-current={page === item.id ? 'page' : undefined}
              className={page === item.id ? 'nav-item selected' : 'nav-item'}
              onClick={() => navigate(item.id)}
            >
              <item.icon size={19} />
              {item.title}
              {item.id === 'servers' && <span className="nav-count">{data.servers.length}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="secure-note">
            <ShieldCheck size={18} />
            <div>
              {data.me.admin ? '관리자 워크스페이스' : '개인 워크스페이스'}
              <small>
                {data.me.admin ? '접근 권한을 한곳에서 관리하세요.' : '허용된 MCP를 확인하세요.'}
              </small>
            </div>
          </div>
          <div className="profile">
            <span className="avatar">{data.me.username.slice(0, 1).toUpperCase()}</span>
            <div>
              {data.me.username}
              <small>{data.me.admin ? 'Workspace admin' : 'Workspace member'}</small>
            </div>
            <button
              className="icon-button"
              title="로그아웃"
              aria-label="로그아웃"
              onClick={() => void logout()}
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-area">
        <header className="topbar">
          <div className="breadcrumb">
            워크스페이스
            <ChevronRight size={14} />
            <strong>{pages.find((item) => item.id === page)!.title}</strong>
          </div>
          <div className="topbar-right">
            <span className="top-status">
              <span className="dot" />
              {config?.mode === 'disabled' ? '개발 모드' : '인증됨'}
            </span>
            <span className="top-separator" />
            <Shield size={17} />
            <span>{data.me.admin ? '관리자' : '사용자'}</span>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <span className="eyebrow">
                {page === 'overview' ? 'WORKSPACE OVERVIEW' : 'WORKSPACE MANAGEMENT'}
              </span>
              <h1>{pages.find((item) => item.id === page)!.title}</h1>
              <p>
                {
                  {
                    overview: '연결된 도구와 팀의 접근 권한을 한눈에 확인하세요.',
                    servers: 'MCP 서버를 연결하고 사용할 도구를 관리하세요.',
                    users: '사용자에게 필요한 MCP 접근 권한을 부여하세요.',
                    groups: '팀별로 사용자를 묶고 MCP 권한을 함께 관리하세요.',
                    audit: '연결과 권한 변경, 도구 호출 내역을 확인하세요.',
                  }[page]
                }
              </p>
            </div>
            <div className="actions">
              <button
                className="secondary"
                disabled={busy}
                onClick={() => void perform(refresh, '최신 정보를 불러왔습니다.')}
              >
                <RefreshCw size={16} className={busy ? 'spin' : ''} />
                새로 고침
              </button>
              {data.me.admin && (page === 'overview' || page === 'servers') && (
                <button className="primary" onClick={() => openMcp()}>
                  <Plus size={17} />
                  MCP 서버 추가
                </button>
              )}
              {page === 'groups' && (
                <button className="primary" onClick={() => openGroup()}>
                  <Plus size={17} />
                  그룹 만들기
                </button>
              )}
              {page === 'users' && (
                <button
                  className="primary"
                  onClick={() => setModal(<UserForm close={close} saved={saved} />)}
                >
                  <Plus size={17} />
                  사용자 등록
                </button>
              )}
            </div>
          </div>
          {error && (
            <div className="error" role="alert">
              {error}
              <button className="icon-button" aria-label="오류 닫기" onClick={() => setError('')}>
                <X size={16} />
              </button>
            </div>
          )}
          {page === 'overview' && (
            <>
              <div className="stats-grid">
                <Stat
                  icon={Blocks}
                  label="등록된 MCP 서버"
                  value={data.servers.length}
                  sub={`${data.servers.filter((server) => server.enabled).length}개 활성화됨`}
                />
                <Stat
                  icon={Zap}
                  label="사용 가능한 도구"
                  value={data.servers.reduce((sum, server) => sum + server.toolCount, 0)}
                  sub="연결 확인 시 조회한 도구"
                />
                <Stat
                  icon={Users}
                  label={data.me.admin ? '등록된 사용자' : '소속 그룹'}
                  value={data.me.admin ? data.users.length : data.me.groups.length}
                  sub={data.me.admin ? 'Keycloak 계정과 연결' : '그룹별 권한이 적용됩니다'}
                />
                <Stat
                  icon={ShieldCheck}
                  label={data.me.admin ? '접근 권한 규칙' : '나의 역할'}
                  value={data.me.admin ? data.grants.length : data.me.roles.length}
                  sub={data.me.admin ? '사용자 및 그룹 직접 설정' : 'Keycloak에서 부여한 역할'}
                />
              </div>
              <div className="endpoint-banner">
                <span className="endpoint-icon">
                  <Network size={24} />
                </span>
                <div>
                  <h3>하나의 주소로 모든 MCP에 연결하세요</h3>
                  <p>MCP 클라이언트에 Gateway 주소를 등록하면 허용된 도구만 표시됩니다.</p>
                </div>
                <button className="endpoint-copy" onClick={copyEndpoint}>
                  <code>{data.me.publicUrl}</code>
                  <Copy size={16} />
                </button>
              </div>
              <div className="overview-grid">
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h2>MCP 서버</h2>
                      <p>워크스페이스에 등록된 연결</p>
                    </div>
                    <button className="text-button" onClick={() => navigate('servers')}>
                      전체 보기
                      <ArrowRight size={15} />
                    </button>
                  </div>
                  {data.servers.length ? (
                    <div className="server-list">
                      {data.servers.slice(0, 5).map((server, i) => (
                        <button
                          className="server-list-row"
                          key={server.id}
                          onClick={() => {
                            navigate('servers');
                            setQuery(server.name);
                          }}
                        >
                          <span className={`server-icon tone-${i % 3}`}>
                            <Blocks size={20} />
                          </span>
                          <div>
                            <strong>{server.name}</strong>
                            <small>{server.description || server.id}</small>
                          </div>
                          <span className="muted">도구 {server.toolCount}개</span>
                          <Badge tone={server.enabled ? 'green' : 'gray'}>
                            {server.enabled ? '연결 확인됨' : '비활성'}
                          </Badge>
                          <ChevronRight size={16} />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <Empty
                      title="아직 연결된 MCP가 없습니다"
                      text="첫 번째 MCP 서버를 등록해 시작하세요."
                    />
                  )}
                </section>
                <section className="panel access-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>안전한 접근 관리</h2>
                      <p>팀에 맞는 권한을 설정하세요</p>
                    </div>
                    <ShieldCheck size={21} />
                  </div>
                  <div className="access-illustration">
                    <div>
                      <Users size={24} />
                    </div>
                    <span>····</span>
                    <div className="access-shield">
                      <ShieldCheck size={32} />
                    </div>
                    <span>····</span>
                    <div>
                      <Blocks size={24} />
                    </div>
                  </div>
                  <h3>필요한 사람에게, 필요한 도구만</h3>
                  <p>
                    사용자별 권한과 그룹 권한을 함께 적용합니다.
                    <br />
                    명시적 차단이 있으면 항상 차단이 우선합니다.
                  </p>
                  {data.me.admin && (
                    <button className="secondary" onClick={() => navigate('groups')}>
                      그룹 권한 관리
                      <ArrowUpRight size={15} />
                    </button>
                  )}
                </section>
              </div>
              {data.me.admin && (
                <section className="panel recent-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>최근 활동</h2>
                      <p>워크스페이스의 최신 변경 내역</p>
                    </div>
                    <button className="text-button" onClick={() => navigate('audit')}>
                      기록 보기
                      <ArrowRight size={15} />
                    </button>
                  </div>
                  <AuditTable events={data.events.slice(0, 5)} users={data.users} />
                </section>
              )}
            </>
          )}
          {page === 'servers' && (
            <section className="panel">
              <Toolbar
                query={query}
                setQuery={setQuery}
                placeholder="MCP 이름 또는 설명 검색"
                count={servers.length}
                label="MCP 서버"
              />
              {servers.length ? (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>MCP 서버</th>
                        <th>연결 방식</th>
                        <th>도구</th>
                        <th>상태</th>
                        <th>관리</th>
                      </tr>
                    </thead>
                    <tbody>
                      {servers.map((server, i) => (
                        <tr key={server.id}>
                          <td>
                            <div className="name-cell">
                              <span className={`server-icon tone-${i % 3}`}>
                                <Blocks size={19} />
                              </span>
                              <div>
                                <strong>{server.name}</strong>
                                <small>{server.description || server.id}</small>
                              </div>
                            </div>
                          </td>
                          <td>
                            <span className="tag">
                              {server.transport === 'http' ? 'Streamable HTTP' : 'stdio'}
                            </span>
                          </td>
                          <td>
                            <button
                              className="text-button"
                              onClick={() =>
                                setModal(
                                  <Modal
                                    title={`${server.name} 도구`}
                                    subtitle="현재 접근 가능한 도구 목록입니다."
                                    close={close}
                                  >
                                    <div className="modal-body tool-list">
                                      {server.toolNames.map((name) => (
                                        <div key={name}>
                                          <Zap size={16} />
                                          <code>
                                            {server.id}__{name}
                                          </code>
                                        </div>
                                      ))}
                                    </div>
                                  </Modal>,
                                )
                              }
                            >
                              {server.toolCount}개 도구
                            </button>
                          </td>
                          <td>
                            <Badge tone={server.enabled ? 'green' : 'gray'}>
                              {server.enabled ? '연결 확인됨' : '비활성'}
                            </Badge>
                          </td>
                          <td>
                            <div className="row-actions">
                              {data.me.admin && (
                                <>
                                  <button
                                    className="icon-button"
                                    aria-label={`${server.name} 연결 확인`}
                                    disabled={busy}
                                    onClick={() =>
                                      void perform(
                                        () => api(`/servers/${server.id}/refresh`, 'POST'),
                                        '연결과 도구 목록을 확인했습니다.',
                                      )
                                    }
                                  >
                                    <RefreshCw size={16} />
                                  </button>
                                  <button
                                    className="secondary small"
                                    onClick={() => openMcp(server)}
                                  >
                                    <Settings2 size={14} />
                                    설정
                                  </button>
                                  {server.source !== 'file' && (
                                    <button
                                      className="text-button danger"
                                      onClick={() =>
                                        confirmDelete('servers', server.id, server.name)
                                      }
                                    >
                                      삭제
                                    </button>
                                  )}
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty
                  title="표시할 MCP 서버가 없습니다"
                  text="검색어를 바꾸거나 MCP 서버를 추가해 주세요."
                />
              )}
            </section>
          )}
          {page === 'users' && (
            <section className="panel">
              <Toolbar
                query={query}
                setQuery={setQuery}
                placeholder="이름 또는 이메일 검색"
                count={users.length}
                label="사용자"
                action={
                  <button
                    className="secondary small"
                    disabled={busy || !data.me.directoryEnabled}
                    title={
                      !data.me.directoryEnabled
                        ? '서버 설정에 Keycloak 디렉터리 계정을 등록하세요.'
                        : undefined
                    }
                    onClick={() =>
                      void perform(
                        () => api('/directory/sync', 'POST'),
                        'Keycloak 사용자를 동기화했습니다.',
                      )
                    }
                  >
                    <RefreshCw size={14} />
                    Keycloak 동기화
                  </button>
                }
              />
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>사용자</th>
                      <th>소속 그룹</th>
                      <th>직접 권한</th>
                      <th>계정 상태</th>
                      <th>관리</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((user) => (
                      <tr key={user.id}>
                        <td>
                          <div className="name-cell">
                            <span className="avatar">
                              {user.username.slice(0, 1).toUpperCase()}
                            </span>
                            <div>
                              <strong>{user.username}</strong>
                              <small>{user.email || '이메일 미등록'}</small>
                            </div>
                          </div>
                        </td>
                        <td>
                          <div className="tags">
                            {data.groups
                              .filter((group) => group.members.includes(user.id))
                              .map((group) => (
                                <span className="tag" key={group.id}>
                                  {group.name}
                                </span>
                              ))}
                            {!data.groups.some((group) => group.members.includes(user.id)) && (
                              <span className="muted">소속 그룹 없음</span>
                            )}
                          </div>
                        </td>
                        <td>
                          {
                            data.grants.filter(
                              (grant) => grant.kind === 'user' && grant.subjectId === user.id,
                            ).length
                          }
                          개 규칙
                        </td>
                        <td>
                          <Badge tone={user.enabled ? 'green' : 'gray'}>
                            {user.enabled ? '활성' : '비활성'}
                          </Badge>
                        </td>
                        <td>
                          <button
                            className="secondary small"
                            onClick={() => permissions('user', user)}
                          >
                            <Shield size={14} />
                            권한 관리
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!users.length && (
                <Empty
                  title="사용자가 없습니다"
                  text="Keycloak에서 동기화하거나 사용자 ID를 등록하세요."
                />
              )}
              <div className="table-note">
                <CircleHelp size={15} />
                계정 생성·비활성화는 Keycloak에서 관리합니다. 여기서는 MCP 권한을 설정합니다.
              </div>
            </section>
          )}
          {page === 'groups' && (
            <>
              <div className="group-toolbar">
                <Toolbar
                  query={query}
                  setQuery={setQuery}
                  placeholder="그룹 이름 검색"
                  count={groups.length}
                  label="그룹"
                />
              </div>
              <div className="group-grid">
                {groups.map((group) => (
                  <section className="panel group-card" key={group.id}>
                    <div className="group-card-top">
                      <span className="group-icon">
                        <FolderKey size={25} />
                      </span>
                      <span className="tag">{group.members.length}명</span>
                    </div>
                    <h2>{group.name}</h2>
                    <p>{group.description || '그룹 설명이 없습니다.'}</p>
                    <div className="group-members">
                      {group.members.slice(0, 5).map((id) => (
                        <span
                          className="avatar small-avatar"
                          title={data.users.find((user) => user.id === id)?.username}
                          key={id}
                        >
                          {(data.users.find((user) => user.id === id)?.username ?? '?')
                            .slice(0, 1)
                            .toUpperCase()}
                        </span>
                      ))}
                      {!group.members.length && (
                        <span className="muted">아직 구성원이 없습니다</span>
                      )}
                    </div>
                    <div className="group-rule">
                      <Shield size={15} />
                      {
                        data.grants.filter(
                          (grant) => grant.kind === 'group' && grant.subjectId === group.id,
                        ).length
                      }
                      개 MCP 권한 규칙
                    </div>
                    <div className="group-card-footer">
                      <button className="secondary small" onClick={() => openGroup(group)}>
                        구성원 관리
                      </button>
                      <button className="text-button" onClick={() => permissions('group', group)}>
                        권한 설정
                        <ArrowRight size={15} />
                      </button>
                      <button
                        className="icon-button danger"
                        aria-label={`${group.name} 삭제`}
                        onClick={() => confirmDelete('groups', group.id, group.name)}
                      >
                        <X size={16} />
                      </button>
                    </div>
                  </section>
                ))}
              </div>
              {!groups.length && (
                <section className="panel">
                  <Empty
                    title="팀의 첫 번째 그룹을 만들어 보세요"
                    text="구성원을 추가하고, MCP 접근 권한을 한 번에 부여할 수 있습니다."
                    action={
                      <button className="primary" onClick={() => openGroup()}>
                        <Plus size={16} />
                        그룹 만들기
                      </button>
                    }
                  />
                </section>
              )}
            </>
          )}
          {page === 'audit' && (
            <section className="panel">
              <Toolbar
                query={query}
                setQuery={setQuery}
                placeholder="작업, 사용자 또는 대상 검색"
                count={
                  data.events.filter((event) =>
                    matches(
                      `${event.actor} ${event.target} ${actionNames[event.action] || event.action}`,
                    ),
                  ).length
                }
                label="최근 기록"
              />
              <AuditTable
                events={data.events.filter((event) =>
                  matches(
                    `${event.actor} ${event.target} ${actionNames[event.action] || event.action}`,
                  ),
                )}
                users={data.users}
              />
              <div className="table-note">
                <CircleHelp size={15} />
                최근 200개 기록을 표시합니다. 토큰과 도구 입력값은 기록하지 않습니다.
              </div>
            </section>
          )}
          <footer className="page-footer">
            <span>MCP Gateway</span>
            <span>
              <ShieldCheck size={13} />
              접근 권한은 모든 MCP 호출에 적용됩니다
            </span>
          </footer>
        </main>
      </div>
      {modal}
      {toast && (
        <div className="toast" role="status">
          <Check size={18} />
          {toast}
        </div>
      )}
    </div>
  );
}
function Stat({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: typeof Server;
  label: string;
  value: number;
  sub: string;
}) {
  return (
    <section className="stat">
      <div>
        <span>{label}</span>
        <Icon size={19} />
      </div>
      <strong>
        {value}
        <small>개</small>
      </strong>
      <p>
        <span className="tiny-dot" />
        {sub}
      </p>
    </section>
  );
}
function Toolbar({
  query,
  setQuery,
  placeholder,
  count,
  label,
  action,
}: {
  query: string;
  setQuery: (value: string) => void;
  placeholder: string;
  count: number;
  label: string;
  action?: ReactNode;
}) {
  return (
    <div className="toolbar">
      <strong>
        {label}
        <span className="count">{count}</span>
      </strong>
      <div className="toolbar-right">
        <label className="search">
          <Search size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholder}
            aria-label={placeholder}
          />
        </label>
        {action}
      </div>
    </div>
  );
}
function AuditTable({ events, users }: { events: Event[]; users: Person[] }) {
  return events.length ? (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>작업</th>
            <th>대상</th>
            <th>사용자</th>
            <th>결과</th>
            <th>시간</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id}>
              <td>
                <div className="audit-action">
                  <Activity size={15} />
                  {actionNames[event.action] ?? event.action}
                </div>
              </td>
              <td className="truncate">{event.target}</td>
              <td>{users.find((user) => user.id === event.actor)?.username ?? event.actor}</td>
              <td>
                <Badge tone={event.outcome === 'success' ? 'green' : 'red'}>
                  {event.outcome === 'success'
                    ? '성공'
                    : event.outcome === 'denied'
                      ? '차단'
                      : '오류'}
                </Badge>
              </td>
              <td className="muted nowrap">{date(event.at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty
      title="아직 활동 기록이 없습니다"
      text="MCP 연결과 권한 변경 내역이 여기에 표시됩니다."
    />
  );
}
function FormFooter({
  close,
  busy,
  label = '저장',
}: {
  close: () => void;
  busy: boolean;
  label?: string;
}) {
  return (
    <div className="modal-footer">
      <button type="button" className="secondary" onClick={close} disabled={busy}>
        취소
      </button>
      <button className="primary" type="submit" disabled={busy}>
        {busy && <RefreshCw size={15} className="spin" />}
        {busy ? '처리 중…' : label}
      </button>
    </div>
  );
}
function McpForm({
  server,
  me,
  close,
  saved,
}: {
  server?: Mcp;
  me: Me;
  close: () => void;
  saved: (message: string) => Promise<void>;
}) {
  const [name, setName] = useState(server?.name ?? '');
  const [id, setId] = useState(server?.id ?? '');
  const [description, setDescription] = useState(server?.description ?? '');
  const [url, setUrl] = useState(server?.upstream?.url ?? '');
  const [auth, setAuth] = useState<Auth>(server?.upstream?.auth ?? { type: 'none' });
  const [enabled, setEnabled] = useState(server?.enabled ?? true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const readonly = server?.source === 'file';
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const cleanAuth =
      auth.type === 'none'
        ? { type: 'none' }
        : auth.type === 'bearer'
          ? { type: 'bearer', tokenEnv: auth.tokenEnv }
          : auth.type === 'apiKey'
            ? { type: 'apiKey', header: auth.header || 'X-API-Key', valueEnv: auth.valueEnv }
            : {
                type: 'clientCredentials',
                tokenUrl: auth.tokenUrl,
                clientId: auth.clientId,
                clientSecretEnv: auth.clientSecretEnv,
                scopes: auth.scopes ?? [],
                ...(auth.resource ? { resource: auth.resource } : {}),
              };
    try {
      await api(server ? `/servers/${server.id}` : '/servers', server ? 'PUT' : 'POST', {
        id,
        name,
        description,
        enabled,
        upstream: {
          transport: 'http',
          url,
          auth: cleanAuth,
          ...(server?.upstream?.policy ? { policy: server.upstream.policy } : {}),
          tools: server?.upstream?.tools ?? {},
        },
      });
      await saved(
        server
          ? 'MCP 서버를 수정했습니다.'
          : 'MCP 서버를 등록했습니다. 사용자 또는 그룹에 권한을 부여하세요.',
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const credentialField =
    auth.type === 'bearer' ? 'tokenEnv' : auth.type === 'apiKey' ? 'valueEnv' : 'clientSecretEnv';
  return (
    <Modal
      title={server ? `${server.name} 설정` : 'MCP 서버 추가'}
      subtitle="외부 MCP를 연결하고 팀의 도구로 등록하세요."
      close={busy ? () => {} : close}
    >
      <form onSubmit={submit}>
        <div className="modal-body">
          {readonly && (
            <div className="info-box">
              <Shield size={18} />
              <p>
                설정 파일에서 관리하는 서버입니다. 연결 정보는 파일에서 수정하고, 접근 권한은
                사용자·그룹 메뉴에서 설정하세요.
              </p>
            </div>
          )}
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <div className="form-grid">
            <label>
              서버 이름
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={100}
                disabled={readonly}
                placeholder="예: 팀 문서 검색"
              />
            </label>
            <label>
              서버 ID
              <input
                value={id}
                onChange={(e) => setId(e.target.value)}
                required
                pattern="[a-zA-Z0-9-]{1,48}"
                disabled={!!server}
                placeholder="예: team-docs"
              />
              <small>영문, 숫자, 하이픈을 사용합니다.</small>
            </label>
          </div>
          <label>
            설명
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              disabled={readonly}
              placeholder="이 MCP가 제공하는 기능을 설명해 주세요"
            />
          </label>
          {server?.transport !== 'stdio' && (
            <>
              <label>
                MCP 서버 URL
                <input
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  required
                  disabled={readonly}
                  placeholder="https://mcp.example.com/mcp"
                />
              </label>
              <label>
                인증 방식
                <select
                  aria-label="인증 방식"
                  value={auth.type}
                  disabled={readonly}
                  onChange={(e) => setAuth({ type: e.target.value })}
                >
                  <option value="none">인증 없음</option>
                  <option value="apiKey">API Key</option>
                  <option value="bearer">Bearer Token</option>
                  <option value="clientCredentials">OAuth 서비스 계정</option>
                </select>
              </label>
              {auth.type === 'apiKey' && (
                <label>
                  API Key 헤더
                  <input
                    value={auth.header ?? 'X-API-Key'}
                    onChange={(e) => setAuth({ ...auth, header: e.target.value })}
                    required
                    disabled={readonly}
                  />
                </label>
              )}
              {auth.type === 'clientCredentials' && (
                <>
                  <label>
                    토큰 발급 URL
                    <input
                      type="url"
                      value={auth.tokenUrl ?? ''}
                      onChange={(e) => setAuth({ ...auth, tokenUrl: e.target.value })}
                      required
                      disabled={readonly}
                    />
                  </label>
                  <label>
                    Client ID
                    <input
                      value={auth.clientId ?? ''}
                      onChange={(e) => setAuth({ ...auth, clientId: e.target.value })}
                      required
                      disabled={readonly}
                    />
                  </label>
                  <label>
                    요청 Scope
                    <input
                      value={(auth.scopes ?? []).join(' ')}
                      onChange={(e) =>
                        setAuth({ ...auth, scopes: e.target.value.split(' ').filter(Boolean) })
                      }
                      disabled={readonly}
                      placeholder="tools:read tools:call"
                    />
                  </label>
                  <label>
                    Resource URL (선택)
                    <input
                      type="url"
                      value={auth.resource ?? ''}
                      onChange={(e) => setAuth({ ...auth, resource: e.target.value })}
                      disabled={readonly}
                    />
                  </label>
                </>
              )}
              {auth.type !== 'none' && (
                <label>
                  등록된 자격 증명
                  <select
                    aria-label="등록된 자격 증명"
                    value={auth[credentialField] ?? ''}
                    onChange={(e) => setAuth({ ...auth, [credentialField]: e.target.value })}
                    required
                    disabled={readonly}
                  >
                    <option value="">자격 증명을 선택하세요</option>
                    {[
                      ...new Set([
                        ...me.credentialEnvs,
                        ...(readonly && auth[credentialField] ? [auth[credentialField]!] : []),
                      ]),
                    ].map((env) => (
                      <option key={env}>{env}</option>
                    ))}
                  </select>
                  <small>운영자가 등록한 비밀 값 참조만 사용할 수 있습니다.</small>
                </label>
              )}
            </>
          )}
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={enabled}
              disabled={readonly}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            연결 확인 후 서버 활성화
          </label>
          {!server && (
            <div className="info-box">
              <ShieldCheck size={18} />
              <p>
                새 MCP는 기본적으로 접근이 차단됩니다. 등록 후 사용자 또는 그룹에 권한을 부여해
                주세요.
              </p>
            </div>
          )}
          {me.allowedUpstreamOrigins.length > 0 && (
            <p className="muted small-text">
              등록 가능한 도메인: {me.allowedUpstreamOrigins.join(', ')}
            </p>
          )}
        </div>
        {readonly ? (
          <div className="modal-footer">
            <button type="button" className="primary" onClick={close}>
              확인
            </button>
          </div>
        ) : (
          <FormFooter
            close={close}
            busy={busy}
            label={server ? '변경 저장' : '연결 확인 및 등록'}
          />
        )}
      </form>
    </Modal>
  );
}
function Permissions({
  kind,
  subject,
  data,
  close,
  saved,
}: {
  kind: 'user' | 'group';
  subject: { id: string; name?: string; username?: string };
  data: Data;
  close: () => void;
  saved: (message: string) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      data.grants
        .filter((grant) => grant.kind === kind && grant.subjectId === subject.id)
        .map((grant) => [grant.serverId, grant.effect]),
    ),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const memberships =
    kind === 'user' ? data.groups.filter((group) => group.members.includes(subject.id)) : [];
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/grants/${kind}/${encodeURIComponent(subject.id)}`, 'PUT', {
        grants: Object.entries(values)
          .filter(([, effect]) => effect !== 'inherit')
          .map(([serverId, effect]) => ({ serverId, effect })),
      });
      await saved('접근 권한을 저장했습니다. 다음 MCP 요청부터 적용됩니다.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`${subject.name ?? subject.username} 접근 권한`}
      subtitle={
        kind === 'user'
          ? '이 사용자에게 적용할 MCP 권한을 설정하세요.'
          : '그룹의 모든 구성원에게 적용할 MCP 권한을 설정하세요.'
      }
      close={busy ? () => {} : close}
    >
      <form onSubmit={submit}>
        <div className="modal-body">
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <div className="info-box">
            <ShieldCheck size={19} />
            <p>
              <strong>차단이 항상 우선합니다.</strong>
              <br />
              사용자 또는 소속 그룹에 차단이 있으면 허용보다 우선합니다. 기본값은 직접 규칙 없이
              그룹·역할 정책을 따릅니다.
            </p>
          </div>
          {memberships.length > 0 && (
            <p className="small-text">
              소속 그룹: {memberships.map((group) => group.name).join(', ')}
            </p>
          )}
          <div className="permission-list">
            {data.servers.map((server) => {
              const inherited = data.grants.filter(
                (grant) =>
                  grant.kind === 'group' &&
                  memberships.some((group) => group.id === grant.subjectId) &&
                  grant.serverId === server.id,
              );
              return (
                <div className="permission-row" key={server.id}>
                  <span className="server-icon">
                    <Blocks size={19} />
                  </span>
                  <div>
                    <strong>{server.name}</strong>
                    <small>
                      {inherited.length
                        ? `그룹 권한: ${inherited.some((grant) => grant.effect === 'deny') ? '차단' : '허용'}`
                        : '그룹 직접 권한 없음'}{' '}
                      · 도구 {server.toolCount}개
                    </small>
                  </div>
                  <select
                    aria-label={`${server.name} 접근 권한`}
                    value={values[server.id] ?? 'inherit'}
                    onChange={(e) => setValues({ ...values, [server.id]: e.target.value })}
                  >
                    <option value="inherit">기본값</option>
                    <option value="allow">허용</option>
                    <option value="deny">차단</option>
                  </select>
                </div>
              );
            })}
          </div>
          <p className="muted small-text">
            도구에 추가 역할·scope 조건이 있으면 해당 조건도 충족해야 합니다. 이미 실행 중인
            작업에는 소급 적용되지 않습니다.
          </p>
        </div>
        <FormFooter close={close} busy={busy} label="권한 저장" />
      </form>
    </Modal>
  );
}
function GroupForm({
  group,
  users,
  close,
  saved,
}: {
  group?: Group;
  users: Person[];
  close: () => void;
  saved: (message: string) => Promise<void>;
}) {
  const [name, setName] = useState(group?.name ?? '');
  const [description, setDescription] = useState(group?.description ?? '');
  const [members, setMembers] = useState(group?.members ?? []);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(group ? `/groups/${group.id}` : '/groups', group ? 'PUT' : 'POST', {
        name,
        description,
        members,
      });
      await saved(
        group ? '그룹 구성원을 저장했습니다.' : '그룹을 만들었습니다. MCP 권한을 설정해 주세요.',
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={group ? `${group.name} 구성원 관리` : '그룹 만들기'}
      subtitle="Gateway에서 함께 권한을 관리할 사용자를 선택하세요."
      close={busy ? () => {} : close}
    >
      <form onSubmit={submit}>
        <div className="modal-body">
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <label>
            그룹 이름
            <input
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="예: 플랫폼 개발팀"
            />
          </label>
          <label>
            설명
            <input
              maxLength={500}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="그룹의 역할과 사용 목적"
            />
          </label>
          <div className="member-heading">
            <strong>구성원 선택</strong>
            <span className="count">{members.length}명</span>
          </div>
          <label className="search member-search">
            <Search size={16} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="사용자 검색"
              aria-label="구성원 검색"
            />
          </label>
          <div className="member-select">
            {users
              .filter((user) =>
                `${user.username} ${user.email}`.toLowerCase().includes(search.toLowerCase()),
              )
              .map((user) => (
                <label className="member-option" key={user.id}>
                  <input
                    type="checkbox"
                    checked={members.includes(user.id)}
                    onChange={(e) =>
                      setMembers(
                        e.target.checked
                          ? [...members, user.id]
                          : members.filter((id) => id !== user.id),
                      )
                    }
                  />
                  <span className="avatar small-avatar">{user.username.slice(0, 1)}</span>
                  <span>
                    {user.username}
                    <small>{user.email || user.id}</small>
                  </span>
                </label>
              ))}
            {!users.length && <p className="muted">먼저 사용자 메뉴에서 계정을 등록해 주세요.</p>}
          </div>
        </div>
        <FormFooter close={close} busy={busy} label={group ? '구성원 저장' : '그룹 만들기'} />
      </form>
    </Modal>
  );
}
function UserForm({
  close,
  saved,
}: {
  close: () => void;
  saved: (message: string) => Promise<void>;
}) {
  const [id, setId] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/users', 'POST', { id, username, email });
      await saved('사용자를 연결했습니다. MCP 접근 권한을 설정할 수 있습니다.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="사용자 등록"
      subtitle="기존 Keycloak 계정을 Gateway 권한 관리에 연결합니다."
      close={busy ? () => {} : close}
    >
      <form onSubmit={submit}>
        <div className="modal-body">
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <label>
            Keycloak 사용자 ID
            <input
              required
              value={id}
              onChange={(e) => setId(e.target.value)}
              maxLength={200}
              placeholder="Keycloak 사용자 상세의 ID"
            />
            <small>토큰의 sub와 동일한 ID여야 합니다.</small>
          </label>
          <label>
            표시 이름
            <input
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              maxLength={100}
              placeholder="홍길동"
            />
          </label>
          <label>
            이메일
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              maxLength={254}
              placeholder="name@company.com"
            />
          </label>
          <div className="info-box">
            <Users size={18} />
            <p>
              로그인 계정과 비밀번호는 Keycloak에서 관리합니다. 사용자가 콘솔에 처음 로그인하면
              자동으로 목록에 등록됩니다.
            </p>
          </div>
        </div>
        <FormFooter close={close} busy={busy} label="사용자 연결" />
      </form>
    </Modal>
  );
}
function Confirm({
  title,
  text,
  close,
  submit,
}: {
  title: string;
  text: string;
  close: () => void;
  submit: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal title={title} close={busy ? () => {} : close}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await submit();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="modal-body">
          <p>{text}</p>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
        </div>
        <FormFooter close={close} busy={busy} label="삭제" />
      </form>
    </Modal>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
