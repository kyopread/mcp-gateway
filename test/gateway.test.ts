import assert from 'node:assert/strict';
import pino from 'pino';
import { test } from 'node:test';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createGateway } from '../src/gateway.js';
import { configSchema, loadConfig } from '../src/config.js';

const logger = pino({ level: 'silent' });

async function listen(gateway: Awaited<ReturnType<typeof createGateway>>) {
  const http = gateway.app.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const url = new URL(`http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`);
  return {
    url,
    close: async () => {
      await gateway.close();
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

test(
  'two stdio servers and an HTTP upstream route tools end to end',
  { timeout: 20000 },
  async (t) => {
    const base = await listen(
      await createGateway(
        {
          ...(await loadConfig('examples/mcp-gateway.demo.json')),
          console: {
            ...configSchema.parse({
              mode: 'development',
              auth: { mode: 'disabled' },
              servers: { demo: { transport: 'stdio', command: 'node' } },
            }).console,
            enabled: false,
          },
        },
        { logger },
      ),
    );
    t.after(base.close);
    const client = new Client({ name: 'test', version: '1.0.0' });
    t.after(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(base.url));
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ['alpha__echo', 'beta__echo'],
    );
    assert.equal(tools[0].inputSchema.type, 'object');
    const results = await Promise.all(
      ['alpha', 'beta'].map((name) =>
        client.callTool({
          name: `${name}__echo`,
          arguments: { text: 'hello' },
        }),
      ),
    );
    assert.deepEqual(
      results.map((result) => result.content),
      [[{ type: 'text', text: 'alpha: hello' }], [{ type: 'text', text: 'beta: hello' }]],
    );
    await assert.rejects(client.callTool({ name: 'missing__echo' }), /Tool unavailable/);
    const invalid = await client.callTool({ name: 'alpha__echo', arguments: { text: 42 } });
    assert.equal(invalid.isError, true);
    const health = await fetch(new URL('/health', base.url));
    assert.deepEqual(await health.json(), { status: 'ok' });
    assert.equal((await fetch(base.url)).status, 405);
    assert.equal(
      (
        await fetch(base.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{',
        })
      ).status,
      400,
    );

    const proxy = await listen(
      await createGateway(
        configSchema.parse({
          mode: 'development',
          auth: { mode: 'disabled' },
          servers: {
            remote: { transport: 'http', url: base.url.href },
          },
        }),
        { logger },
      ),
    );
    t.after(proxy.close);
    const remote = new Client({ name: 'http-test', version: '1.0.0' });
    t.after(() => remote.close());
    await remote.connect(new StreamableHTTPClientTransport(proxy.url));
    assert.deepEqual(
      (await remote.listTools()).tools.map((tool) => tool.name),
      ['remote__alpha__echo', 'remote__beta__echo'],
    );
    assert.deepEqual(
      (await remote.callTool({ name: 'remote__beta__echo', arguments: { text: 'HTTP' } })).content,
      [{ type: 'text', text: 'beta: HTTP' }],
    );
  },
);

test('invalid configuration fails early', () => {
  assert.throws(() =>
    configSchema.parse({ mode: 'development', auth: { mode: 'disabled' }, servers: {} }),
  );
  assert.throws(() =>
    configSchema.parse({
      mode: 'development',
      auth: { mode: 'disabled' },
      servers: { bad__name: { transport: 'stdio', command: 'node' } },
    }),
  );
  assert.throws(() =>
    configSchema.parse({
      mode: 'development',
      auth: { mode: 'disabled' },
      servers: { remote: { transport: 'http', url: 'file:///tmp/server' } },
    }),
  );
});

test('unavailable upstream fails startup', { timeout: 5000 }, async () => {
  await assert.rejects(
    createGateway(
      configSchema.parse({
        mode: 'development',
        auth: { mode: 'disabled' },
        timeoutMs: 500,
        servers: {
          broken: {
            transport: 'stdio',
            command: process.execPath,
            args: ['-e', 'process.exit(1)'],
          },
        },
      }),
      { logger },
    ),
  );
});
