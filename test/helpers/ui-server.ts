// Isolated browser-test identity provider. Never imported by the application.
import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { identityProvider, externalMcp } from './servers.js';
import { createGateway } from '../../src/gateway.js';
import { configSchema } from '../../src/config.js';
import pino from 'pino';

const origin = 'http://127.0.0.1:3100';
const idp = await identityProvider();
// Use a fixed IdP HTTP port for the browser fixture, while signing with the fixture JWKS.
const idpApp = express();
idpApp.use(express.urlencoded({ extended: false }));
const authRequests = new Map<string, URLSearchParams>();
const codes = new Map<string, { params: URLSearchParams; user: string }>();
let pkceChecks = 0;
const issuer = 'http://127.0.0.1:3101/realms/test';
idpApp.get('/realms/test/protocol/openid-connect/certs', async (_req, res) => {
  res.json(await (await fetch(`${idp.issuer}/protocol/openid-connect/certs`)).json());
});
idpApp.get('/realms/test/protocol/openid-connect/auth', (req, res) => {
  const params = new URLSearchParams(req.url.split('?')[1]);
  if (
    params.get('redirect_uri') !== `${origin}/auth/callback` ||
    params.get('client_id') !== 'mcp-console' ||
    params.get('code_challenge_method') !== 'S256'
  ) {
    res.status(400).send('Invalid test OAuth request');
    return;
  }
  const id = randomUUID();
  authRequests.set(id, params);
  res
    .type('html')
    .send(
      `<!doctype html><html lang="ko"><head><title>Test Keycloak</title></head><body><h1>테스트 Keycloak 로그인</h1><p>격리된 브라우저 테스트용 계정입니다.</p><form method="post" action="/login"><input type="hidden" name="request" value="${id}"><label>사용자 이름<input name="username" required></label><label>비밀번호<input name="password" type="password" required></label><button>로그인</button></form></body></html>`,
    );
});
idpApp.post('/login', (req, res) => {
  const params = authRequests.get(req.body.request);
  authRequests.delete(req.body.request);
  if (
    !params ||
    !['admin', 'alice'].includes(req.body.username) ||
    req.body.password !== 'fixture-password'
  ) {
    res.status(401).end();
    return;
  }
  const code = randomUUID();
  codes.set(code, { params, user: req.body.username });
  const redirect = new URL(params.get('redirect_uri')!);
  redirect.searchParams.set('code', code);
  redirect.searchParams.set('state', params.get('state')!);
  redirect.searchParams.set('iss', issuer);
  res.redirect(redirect.href);
});
idpApp.options('/realms/test/protocol/openid-connect/token', (_req, res) => {
  res
    .set('Access-Control-Allow-Origin', origin)
    .set('Access-Control-Allow-Credentials', 'true')
    .set('Access-Control-Allow-Headers', 'Content-Type')
    .status(204)
    .end();
});
idpApp.post('/realms/test/protocol/openid-connect/token', async (req, res) => {
  res.set('Access-Control-Allow-Origin', origin).set('Access-Control-Allow-Credentials', 'true');
  const entry = codes.get(req.body.code);
  codes.delete(req.body.code);
  if (
    !entry ||
    req.body.grant_type !== 'authorization_code' ||
    req.body.client_id !== 'mcp-console' ||
    req.body.redirect_uri !== `${origin}/auth/callback` ||
    createHash('sha256')
      .update(req.body.code_verifier ?? '')
      .digest('base64url') !== entry.params.get('code_challenge')
  ) {
    res.status(400).json({ error: 'invalid_grant' });
    return;
  }
  pkceChecks++;
  const claims = {
    sub: entry.user,
    preferred_username: entry.user === 'admin' ? '워크스페이스 관리자' : 'Alice',
    iss: issuer,
    aud: `${origin}/mcp`,
    nonce: entry.params.get('nonce'),
    resource_access: { 'mcp-gateway': { roles: entry.user === 'admin' ? ['gateway-admin'] : [] } },
  };
  res.json({
    access_token: await idp.token(claims),
    id_token: await idp.token({ ...claims, aud: 'mcp-console', typ: 'ID' }),
    refresh_token: await idp.token({ ...claims, typ: 'Refresh' }),
    token_type: 'Bearer',
    expires_in: 300,
  });
});
idpApp.get('/realms/test/protocol/openid-connect/logout', (_req, res) => res.redirect(origin));
idpApp.get('/test-pkce-count', (_req, res) => res.json({ count: pkceChecks }));
const idpHttp = idpApp.listen(3101, '127.0.0.1');
process.env.UI_EXTERNAL_KEY = 'ui-external-fixture';
const external = await externalMcp({ header: 'x-api-key', value: 'ui-external-fixture' });
const config = configSchema.parse({
  mode: 'development',
  port: 3100,
  publicUrl: `${origin}/mcp`,
  auth: { mode: 'keycloak', issuer },
  console: { enabled: true, databasePath: ':memory:', credentialEnvs: ['UI_EXTERNAL_KEY'] },
  servers: {
    alpha: { transport: 'stdio', command: 'node', args: ['examples/demo-server.mjs', 'alpha'] },
    beta: { transport: 'stdio', command: 'node', args: ['examples/demo-server.mjs', 'beta'] },
  },
});
const gateway = await createGateway(config, { logger: pino({ level: 'silent' }) });
// Fixture metadata contains no secrets, only the local test target URL.
gateway.app.get('/test-fixture', (_req, res) =>
  res.json({ externalUrl: `${external.origin}/mcp` }),
);
const http = gateway.app.listen(3100, '127.0.0.1');
const close = async () => {
  await gateway.close();
  http.closeAllConnections();
  http.close();
  await external.close();
  idpHttp.closeAllConnections();
  idpHttp.close();
  await idp.close();
};
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());
