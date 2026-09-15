import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const config = JSON.parse(
  await readFile(process.env.MCP_GATEWAY_CONFIG ?? 'config/local.json', 'utf8'),
);
if (config.auth.mode !== 'keycloak')
  throw new Error('Smoke check requires Keycloak authentication');
const issuer = config.auth.issuer;
const gatewayUrl = config.publicUrl;
const secret = process.env.GATEWAY_SMOKE_CLIENT_SECRET;
if (!secret) throw new Error('Set GATEWAY_SMOKE_CLIENT_SECRET');
const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
  method: 'POST',
  redirect: 'error',
  signal: AbortSignal.timeout(10000),
  body: new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: 'gateway-smoke',
    client_secret: secret,
    scope: 'mcp:access',
  }),
});
if (!response.ok) throw new Error(`Keycloak token request failed (${response.status})`);
const { access_token } = await response.json();
assert.equal(typeof access_token, 'string');
const client = new Client({ name: 'keycloak-smoke', version: '1.0.0' });
try {
  const unauthenticated = await fetch(gatewayUrl, { method: 'POST' });
  assert.equal(unauthenticated.status, 401);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(gatewayUrl), {
      requestInit: { headers: { Authorization: `Bearer ${access_token}` } },
    }),
  );
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['alpha__echo'],
  );
  const result = await client.callTool({
    name: 'alpha__echo',
    arguments: { text: 'Keycloak authenticated' },
  });
  assert.deepEqual(result.content, [{ type: 'text', text: 'alpha: Keycloak authenticated' }]);
  await assert.rejects(
    client.callTool({ name: 'beta__echo', arguments: { text: 'denied' } }),
    /access denied/,
  );
  console.log(
    'PASS: Keycloak authentication, reader tool filtering, allowed call and admin-tool denial',
  );
} finally {
  await client.close();
}
