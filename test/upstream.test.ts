import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import pino from 'pino';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createGateway } from '../src/gateway.js';
import { configSchema } from '../src/config.js';
import { createUpstreamFetch } from '../src/upstream.js';
import { externalMcp, serve } from './helpers/servers.js';

const logger = pino({ level: 'silent' });
const base = { mode: 'development', auth: { mode: 'disabled' } };

test('external API-key MCP works; missing secrets fail closed', async (t) => {
  process.env.TEST_EXTERNAL_KEY = 'external-api-key';
  t.after(() => {
    delete process.env.TEST_EXTERNAL_KEY;
  });
  const upstream = await externalMcp({ header: 'x-api-key', value: 'external-api-key' });
  t.after(upstream.close);
  const config = configSchema.parse({
    ...base,
    servers: {
      remote: {
        transport: 'http',
        url: `${upstream.origin}/mcp`,
        auth: { type: 'apiKey', header: 'X-API-Key', valueEnv: 'TEST_EXTERNAL_KEY' },
      },
    },
  });
  const gateway = await createGateway(config, { logger });
  t.after(gateway.close);
  const http = await serve(gateway.app);
  t.after(http.close);
  const client = new Client({ name: 'test', version: '1' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${http.origin}/mcp`)));
  assert.deepEqual(
    (await client.callTool({ name: 'remote__echo', arguments: { text: 'api-key' } })).content,
    [{ type: 'text', text: '1: api-key' }],
  );
  assert.ok(
    upstream.observed.every(
      (request) => request.apiKey === 'external-api-key' && !request.authorization,
    ),
  );
  delete process.env.TEST_EXTERNAL_KEY;
  await assert.rejects(createGateway(config, { logger }), /TEST_EXTERNAL_KEY/);
});

test('client credentials: single-flight cache, expiry refresh, 401 invalidation and destination binding', async (t) => {
  process.env.TEST_CLIENT_SECRET = 'test-client-secret';
  t.after(() => {
    delete process.env.TEST_CLIENT_SECRET;
  });
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  let tokenRequests = 0;
  let expiry = 0.1;
  let rejectToken = false;
  let resourceRequests = 0;
  app.post('/token', (req, res) => {
    tokenRequests++;
    assert.equal(req.body.grant_type, 'client_credentials');
    assert.equal(req.body.client_id, 'external-client');
    assert.equal(req.body.client_secret, 'test-client-secret');
    assert.equal(req.body.scope, 'tools:read tools:call');
    res.json({
      access_token: `service-token-${tokenRequests}`,
      token_type: 'Bearer',
      expires_in: expiry,
    });
  });
  app.post('/mcp', (req, res) => {
    resourceRequests++;
    assert.match(req.headers.authorization!, /^Bearer service-token-/);
    res.status(rejectToken ? 401 : 200).json({ authorization: req.headers.authorization });
  });
  const http = await serve(app);
  t.after(http.close);
  const config = configSchema.parse({
    ...base,
    servers: {
      remote: {
        transport: 'http',
        url: `${http.origin}/mcp`,
        auth: {
          type: 'clientCredentials',
          tokenUrl: `${http.origin}/token`,
          clientId: 'external-client',
          clientSecretEnv: 'TEST_CLIENT_SECRET',
          scopes: ['tools:read', 'tools:call'],
        },
      },
    },
  });
  const remote = config.servers.remote;
  assert.equal(remote.transport, 'http');
  if (remote.transport !== 'http') return;
  const boundFetch = createUpstreamFetch(remote, 1000);
  const request = () =>
    boundFetch(`${http.origin}/mcp`, {
      method: 'POST',
      headers: { Authorization: 'Bearer incoming-user-token' },
    });
  const responses = await Promise.all([request(), request(), request()]);
  await Promise.all(responses.map((response) => response.json()));
  assert.equal(tokenRequests, 1);
  await new Promise((resolve) => setTimeout(resolve, 150));
  expiry = 3600;
  await (await request()).json();
  assert.equal(tokenRequests, 2);
  rejectToken = true;
  assert.equal((await request()).status, 401);
  assert.equal(resourceRequests, 5, '401 does not replay a potentially mutating operation');
  rejectToken = false;
  await (await request()).json();
  assert.equal(tokenRequests, 3);
  await assert.rejects(
    boundFetch(`${http.origin}/other`, { method: 'POST' }),
    /destination mismatch/,
  );
});

test('redirects never forward secrets and malformed token responses fail', async (t) => {
  process.env.TEST_REDIRECT_TOKEN = 'redirect-secret';
  process.env.TEST_OAUTH_SECRET = 'oauth-secret';
  t.after(() => {
    delete process.env.TEST_REDIRECT_TOKEN;
    delete process.env.TEST_OAUTH_SECRET;
  });
  let targetHits = 0;
  const app = express();
  app.all('/mcp', (_req, res) => res.redirect(307, '/stolen'));
  app.all('/stolen', (_req, res) => {
    targetHits++;
    res.end();
  });
  app.post('/token', (_req, res) => res.json({ access_token: 'token', token_type: 'Bearer' }));
  const http = await serve(app);
  t.after(http.close);
  for (const auth of [
    { type: 'bearer', tokenEnv: 'TEST_REDIRECT_TOKEN' },
    {
      type: 'clientCredentials',
      tokenUrl: `${http.origin}/token`,
      clientId: 'test',
      clientSecretEnv: 'TEST_OAUTH_SECRET',
    },
  ]) {
    const server = configSchema.parse({
      ...base,
      servers: { remote: { transport: 'http', url: `${http.origin}/mcp`, auth } },
    }).servers.remote;
    if (server.transport !== 'http') throw new Error('Expected HTTP');
    await assert.rejects(
      createUpstreamFetch(server, 1000)(`${http.origin}/mcp`, { method: 'POST' }),
    );
  }
  assert.equal(targetHits, 0);
});

test(
  'call deadline and concurrency limit; later calls recover without replay',
  { timeout: 10000 },
  async (t) => {
    process.env.TEST_SLOW_TOKEN = 'slow-secret';
    t.after(() => {
      delete process.env.TEST_SLOW_TOKEN;
    });
    const upstream = await externalMcp({ header: 'authorization', value: 'Bearer slow-secret' });
    t.after(upstream.close);
    const gateway = await createGateway(
      configSchema.parse({
        ...base,
        timeoutMs: 300,
        maxConcurrentRequests: 1,
        servers: {
          remote: {
            transport: 'http',
            url: `${upstream.origin}/mcp`,
            auth: { type: 'bearer', tokenEnv: 'TEST_SLOW_TOKEN' },
          },
        },
      }),
      { logger },
    );
    t.after(gateway.close);
    const http = await serve(gateway.app);
    t.after(http.close);
    const post = () =>
      fetch(`${http.origin}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'remote__echo', arguments: { text: 'slow' } },
        }),
      });
    upstream.delay(600);
    const first = post();
    const deadline = Date.now() + 2000;
    while (upstream.calls() === 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(upstream.calls(), 1);
    assert.equal((await post()).status, 503);
    const failure = (await (await first).json()).error;
    assert.equal(failure.code, -32603);
    assert.match(failure.message, /Upstream call failed$/);
    assert.equal(upstream.calls(), 1);
    upstream.delay(0);
    assert.deepEqual((await (await post()).json()).result.content, [
      { type: 'text', text: '1: slow' },
    ]);
  },
);
