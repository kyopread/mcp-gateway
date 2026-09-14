import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import { generateKeyPair } from 'jose';
import pino from 'pino';
import { createGateway } from '../src/gateway.js';
import { configSchema } from '../src/config.js';
import { identityProvider, serve, externalMcp } from './helpers/servers.js';

const silent = pino({ level: 'silent' });

test(
  'Keycloak JWT validation, default-deny RBAC, MCP metadata and security boundaries',
  { timeout: 30000 },
  async (t) => {
    const idp = await identityProvider();
    t.after(idp.close);
    process.env.TEST_UPSTREAM_TOKEN = 'upstream-service-secret';
    t.after(() => {
      delete process.env.TEST_UPSTREAM_TOKEN;
    });
    const upstream = await externalMcp({
      header: 'authorization',
      value: 'Bearer upstream-service-secret',
    });
    t.after(upstream.close);
    const logs: Record<string, unknown>[] = [];
    const logger = pino(
      {},
      {
        write: (line: string) => {
          logs.push(JSON.parse(line));
        },
      },
    );
    const gateway = await createGateway(
      configSchema.parse({
        mode: 'development',
        timeoutMs: 2000,
        auth: { mode: 'keycloak', issuer: idp.issuer },
        servers: {
          alpha: {
            transport: 'http',
            url: `${upstream.origin}/mcp`,
            auth: { type: 'bearer', tokenEnv: 'TEST_UPSTREAM_TOKEN' },
            policy: { anyRole: ['client:reader', 'client:admin'] },
          },
          beta: {
            transport: 'stdio',
            command: 'node',
            args: ['examples/demo-server.mjs', 'beta'],
            policy: { anyRole: ['client:admin'] },
            tools: { echo: { allScopes: ['beta:call'] } },
          },
          hidden: {
            transport: 'stdio',
            command: 'node',
            args: ['examples/demo-server.mjs', 'hidden'],
          },
        },
      }),
      { logger },
    );
    t.after(gateway.close);
    const http = await serve(gateway.app);
    t.after(http.close);
    const post = async (token?: string, method = 'tools/list', params?: unknown, headers = {}) =>
      fetch(`${http.origin}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2025-11-25',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
      });
    const alice = await idp.token();
    await t.test(
      '401 includes protected resource discovery; metadata uses configured URL',
      async () => {
        const response = await post();
        assert.equal(response.status, 401);
        assert.match(
          response.headers.get('www-authenticate')!,
          /resource_metadata="http:\/\/127.0.0.1:3000\/\.well-known\/oauth-protected-resource\/mcp"/,
        );
        const metadata = await (
          await fetch(`${http.origin}/.well-known/oauth-protected-resource/mcp`)
        ).json();
        assert.equal(metadata.resource, 'http://127.0.0.1:3000/mcp');
        assert.deepEqual(metadata.authorization_servers, [idp.issuer]);
        assert.ok(metadata.scopes_supported.includes('beta:call'));
      },
    );
    await t.test(
      'invalid issuer, audience, expiry, not-before, missing claims and ID tokens are rejected',
      async () => {
        for (const claims of [
          { iss: 'https://attacker.example' },
          { aud: 'another-service' },
          { exp: 1 },
          { exp: undefined },
          { sub: undefined },
          { iat: undefined },
          { nbf: Math.floor(Date.now() / 1000) + 1000 },
          { typ: 'ID' },
          { typ: undefined },
          { iat: Math.floor(Date.now() / 1000) + 1000 },
        ]) {
          assert.equal((await post(await idp.token(claims))).status, 401, JSON.stringify(claims));
        }
        const forged = await generateKeyPair('RS256');
        assert.equal((await post(await idp.token({}, forged.privateKey))).status, 401);
        assert.equal((await post('not-a-jwt')).status, 401);
      },
    );
    await t.test('missing required scope returns 403 and scope challenge', async () => {
      const response = await post(await idp.token({ scope: 'openid' }));
      assert.equal(response.status, 403);
      assert.match(
        response.headers.get('www-authenticate')!,
        /insufficient_scope.*scope="mcp:access"/,
      );
    });
    await t.test(
      'reader sees alpha only; other clients and realm roles cannot impersonate client roles',
      async () => {
        assert.deepEqual(
          (await (await post(alice)).json()).result.tools.map(
            (tool: { name: string }) => tool.name,
          ),
          ['alpha__echo'],
        );
        for (const claims of [
          { resource_access: {} },
          { resource_access: { unrelated: { roles: ['admin'] } } },
          { resource_access: {}, realm_access: { roles: ['admin'] } },
        ]) {
          assert.deepEqual((await (await post(await idp.token(claims))).json()).result.tools, []);
        }
        assert.equal(idp.jwksRequests(), 1, 'keys are cached across requests');
      },
    );
    await t.test('direct unauthorized calls are blocked before upstream invocation', async () => {
      const count = upstream.calls();
      const unprivileged = await idp.token({ resource_access: {} });
      const response = await (
        await post(unprivileged, 'tools/call', {
          name: 'alpha__echo',
          arguments: { text: 'denied' },
        })
      ).json();
      assert.equal(response.error.code, -32602);
      assert.equal(upstream.calls(), count);
      assert.match(response.error.message, /access denied/);
    });
    await t.test(
      'tool policy adds scope restriction without weakening server role policy',
      async () => {
        const admin = { resource_access: { 'mcp-gateway': { roles: ['admin'] } } };
        assert.equal((await (await post(await idp.token(admin))).json()).result.tools.length, 1);
        const response = await post(await idp.token({ ...admin, scope: 'mcp:access beta:call' }));
        assert.deepEqual(
          (await response.json()).result.tools.map((tool: { name: string }) => tool.name),
          ['alpha__echo', 'beta__echo'],
        );
        const denied = await post(
          await idp.token({ scope: 'mcp:access beta:call' }),
          'tools/call',
          { name: 'beta__echo', arguments: { text: 'x' } },
        );
        assert.ok((await denied.json()).error);
      },
    );
    await t.test(
      'fresh upstream sessions and separate credentials; client metadata never forwarded',
      async () => {
        for (const token of [alice, await idp.token({ sub: 'bob' })]) {
          const response = await post(token, 'tools/call', {
            name: 'alpha__echo',
            arguments: { text: 'private-argument' },
            _meta: { authorization: 'untrusted-metadata-secret' },
          });
          assert.deepEqual((await response.json()).result.content, [
            { type: 'text', text: '1: private-argument' },
          ]);
        }
        assert.equal(upstream.sessions(), 0);
        assert.ok(
          upstream.observed.every(
            (request) => request.authorization === 'Bearer upstream-service-secret',
          ),
        );
        assert.ok(upstream.observed.every((request) => request.meta === undefined));
        const serialized = JSON.stringify(logs);
        for (const secret of [
          alice,
          'upstream-service-secret',
          'private-argument',
          'untrusted-metadata-secret',
        ])
          assert.ok(!serialized.includes(secret));
        assert.ok(logs.some((log) => log.event === 'tool_call' && log.outcome === 'denied'));
        assert.ok(logs.some((log) => log.event === 'tool_call' && log.outcome === 'success'));
      },
    );
    await t.test('host/origin checks, body limits and sanitized JSON errors', async () => {
      assert.equal(
        (await post(alice, 'tools/list', undefined, { Origin: 'https://attacker.example' })).status,
        403,
      );
      const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
        const request = httpRequest(
          `${http.origin}/mcp`,
          { headers: { Host: 'attacker.example' } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        request.on('error', reject);
        request.end();
      });
      assert.equal(hostStatus, 403);
      const malformed = await fetch(`${http.origin}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${alice}`,
          'Content-Type': 'application/json',
        },
        body: '{',
      });
      assert.equal(malformed.status, 400);
      assert.deepEqual(await malformed.json(), { error: 'invalid_json' });
      const oversized = await post(alice, 'tools/call', {
        name: 'alpha__echo',
        arguments: { text: 'x'.repeat(1024 * 1024) },
      });
      assert.equal(oversized.status, 413);
      assert.equal((await fetch(`${http.origin}/mcp?access_token=${alice}`)).status, 401);
    });
  },
);

test('production configuration rejects insecure operation and supports explicit policy semantics', () => {
  const base = {
    publicUrl: 'https://gateway.example/mcp',
    auth: { mode: 'keycloak', issuer: 'https://sso.example/realms/mcp' },
    servers: { remote: { transport: 'http', url: 'https://mcp.example/mcp' } },
  };
  assert.equal(configSchema.parse(base).mode, 'production');
  for (const override of [
    { auth: { mode: 'disabled' } },
    { publicUrl: 'http://gateway.example/mcp' },
    { auth: { mode: 'keycloak', issuer: 'http://sso.example/realms/mcp' } },
    { servers: { remote: { transport: 'http', url: 'http://mcp.example/mcp' } } },
    { publicUrl: 'https://gateway.example/mcp?token=x' },
    { unknown: true },
    { trustedProxies: ['all'] },
    { servers: { remote: { transport: 'http', url: 'https://user:pass@mcp.example/mcp' } } },
  ]) {
    assert.throws(() => configSchema.parse({ ...base, ...override }));
  }
  assert.throws(() =>
    configSchema.parse({
      ...base,
      mode: 'development',
      host: '0.0.0.0',
      auth: { mode: 'disabled' },
    }),
  );
});

test('per-process rate limit is enforced', async (t) => {
  const gateway = await createGateway(
    configSchema.parse({
      mode: 'development',
      auth: { mode: 'disabled' },
      rateLimitPerMinute: 1,
      servers: {
        demo: { transport: 'stdio', command: 'node', args: ['examples/demo-server.mjs'] },
      },
    }),
    { logger: silent },
  );
  t.after(gateway.close);
  const http = await serve(gateway.app);
  t.after(http.close);
  assert.equal((await fetch(`${http.origin}/mcp`)).status, 405);
  const response = await fetch(`${http.origin}/mcp`);
  assert.equal(response.status, 429);
  assert.ok(response.headers.has('retry-after'));
  assert.equal((await fetch(`${http.origin}/health`)).status, 200);
});
