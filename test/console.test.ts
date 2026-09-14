import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { createGateway } from '../src/gateway.js';
import { configSchema } from '../src/config.js';
import { externalMcp, identityProvider, serve } from './helpers/servers.js';

const logger = pino({ level: 'silent' });
test(
  'console admin boundary, per-user and group grants, live revocation, persistence and MCP registration',
  { timeout: 30000 },
  async (t) => {
    const idp = await identityProvider();
    t.after(idp.close);
    const directory = await mkdtemp(join(tmpdir(), 'mcp-console-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const config = configSchema.parse({
      mode: 'development',
      auth: { mode: 'keycloak', issuer: idp.issuer },
      console: {
        enabled: true,
        databasePath: join(directory, 'gateway.sqlite'),
        credentialEnvs: ['TEST_CONSOLE_KEY'],
      },
      servers: {
        alpha: { transport: 'stdio', command: 'node', args: ['examples/demo-server.mjs', 'alpha'] },
      },
    });
    let gateway = await createGateway(config, { logger });
    let http = await serve(gateway.app);
    t.after(async () => {
      await gateway.close();
      await http.close();
    });
    const admin = await idp.token({
      sub: 'administrator',
      resource_access: { 'mcp-gateway': { roles: ['gateway-admin'] } },
    });
    const alice = await idp.token({ preferred_username: 'Alice', resource_access: {} });
    const bob = await idp.token({ sub: 'bob', preferred_username: 'Bob', resource_access: {} });
    const request = (path: string, token = admin, method = 'GET', body?: unknown) =>
      fetch(`${http.origin}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const mcp = async (token: string, method = 'tools/list', params?: unknown) =>
      (
        await fetch(`${http.origin}/mcp`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
        })
      ).json();
    await t.test(
      'public login config contains no credentials; normal users cannot use admin APIs',
      async () => {
        const response = await fetch(`${http.origin}/api/config`);
        assert.equal(response.status, 200);
        assert.ok(!JSON.stringify(await response.json()).includes('credentialEnvs'));
        assert.equal((await fetch(`${http.origin}/api/users`)).status, 401);
        assert.equal((await request('/api/users', alice)).status, 403);
        assert.equal(
          (await request('/api/groups', alice, 'POST', { name: 'attacker' })).status,
          403,
        );
        assert.equal(
          (await request('/api/grants/user/alice', alice, 'PUT', { grants: [] })).status,
          403,
        );
        const toolsAdmin = await idp.token({
          resource_access: { 'mcp-gateway': { roles: ['admin'] } },
        });
        assert.equal((await request('/api/users', toolsAdmin)).status, 403);
        assert.equal((await request('/api/me', admin)).status, 200);
        assert.equal((await request('/api/me', alice)).status, 200);
        assert.equal((await request('/api/me', bob)).status, 200);
        assert.deepEqual(await (await request('/api/servers', alice)).json(), []);
        assert.deepEqual((await mcp(alice)).result.tools, []);
      },
    );
    let groupId: string;
    await t.test('group grant permits its member but not other users', async () => {
      const response = await request('/api/groups', admin, 'POST', {
        name: 'Platform',
        members: ['alice'],
      });
      assert.equal(response.status, 201);
      groupId = (await response.json()).id;
      assert.equal(
        (
          await request(`/api/grants/group/${groupId}`, admin, 'PUT', {
            grants: [{ serverId: 'alpha', effect: 'allow' }],
          })
        ).status,
        200,
      );
      assert.deepEqual(
        (await mcp(alice)).result.tools.map((tool: { name: string }) => tool.name),
        ['alpha__echo'],
      );
      assert.deepEqual((await mcp(bob)).result.tools, []);
      const result = await mcp(alice, 'tools/call', {
        name: 'alpha__echo',
        arguments: { text: 'member' },
      });
      assert.deepEqual(result.result.content, [{ type: 'text', text: 'alpha: member' }]);
      const visible = await (await request('/api/servers', alice)).json();
      assert.equal(visible.length, 1);
      assert.equal(visible[0].upstream, undefined);
    });
    await t.test(
      'explicit user denial wins over group allow; revocation applies to the same JWT',
      async () => {
        await request('/api/grants/user/alice', admin, 'PUT', {
          grants: [{ serverId: 'alpha', effect: 'deny' }],
        });
        assert.deepEqual((await mcp(alice)).result.tools, []);
        assert.equal(
          (await mcp(alice, 'tools/call', { name: 'alpha__echo', arguments: { text: 'denied' } }))
            .error.code,
          -32602,
        );
        await request('/api/grants/user/alice', admin, 'PUT', { grants: [] });
        assert.equal((await mcp(alice)).result.tools.length, 1);
        await request(`/api/groups/${groupId}`, admin, 'PUT', { name: 'Platform', members: [] });
        assert.equal((await mcp(alice)).result.tools.length, 0);
        await request('/api/grants/user/alice', admin, 'PUT', {
          grants: [{ serverId: 'alpha', effect: 'allow' }],
        });
        assert.equal((await mcp(alice)).result.tools.length, 1);
        await request(`/api/groups/${groupId}`, admin, 'PUT', {
          name: 'Platform',
          members: ['alice'],
        });
        await request(`/api/grants/group/${groupId}`, admin, 'PUT', {
          grants: [{ serverId: 'alpha', effect: 'deny' }],
        });
        assert.equal(
          (await mcp(alice)).result.tools.length,
          0,
          'group deny wins over individual allow',
        );
        await request(`/api/grants/group/${groupId}`, admin, 'PUT', { grants: [] });
      },
    );
    await t.test('groups, users and grants survive restart', async () => {
      await gateway.close();
      await http.close();
      gateway = await createGateway(config, { logger });
      http = await serve(gateway.app);
      assert.equal((await mcp(alice)).result.tools.length, 1);
      assert.equal((await (await request('/api/groups')).json())[0].members[0], 'alice');
      assert.ok(
        (await (await request('/api/audit')).json()).some(
          (event: { action: string }) => event.action === 'permissions.user.update',
        ),
      );
    });
    await t.test(
      'HTTP MCP registration is live, default denied, secret allowlist enforced and removal revokes access',
      async () => {
        process.env.TEST_CONSOLE_KEY = 'console-external-key';
        t.after(() => {
          delete process.env.TEST_CONSOLE_KEY;
        });
        const external = await externalMcp({ header: 'x-api-key', value: 'console-external-key' });
        t.after(external.close);
        const record = {
          id: 'external',
          name: 'External',
          upstream: {
            transport: 'http',
            url: `${external.origin}/mcp`,
            auth: { type: 'apiKey', header: 'x-api-key', valueEnv: 'TEST_CONSOLE_KEY' },
          },
        };
        assert.equal(
          (
            await request('/api/servers', admin, 'POST', {
              ...record,
              id: 'forbidden',
              upstream: {
                ...record.upstream,
                auth: { ...record.upstream.auth, valueEnv: 'KEYCLOAK_ADMIN_PASSWORD' },
              },
            })
          ).status,
          422,
        );
        assert.equal(
          (
            await request('/api/servers', admin, 'POST', {
              id: 'shell',
              name: 'Shell',
              upstream: { transport: 'stdio', command: 'node' },
            })
          ).status,
          422,
        );
        assert.equal((await request('/api/servers', admin, 'POST', record)).status, 201);
        assert.equal((await request('/api/servers', admin, 'POST', record)).status, 409);
        assert.ok(!(await mcp(bob)).result.tools.length);
        await request('/api/grants/user/bob', admin, 'PUT', {
          grants: [{ serverId: 'external', effect: 'allow' }],
        });
        assert.equal((await mcp(bob)).result.tools[0].name, 'external__echo');
        assert.deepEqual(
          (await mcp(bob, 'tools/call', { name: 'external__echo', arguments: { text: 'live' } }))
            .result.content,
          [{ type: 'text', text: '1: live' }],
        );
        assert.equal(
          (await request('/api/servers/external', admin, 'PUT', { ...record, enabled: false }))
            .status,
          200,
        );
        assert.equal((await mcp(bob)).result.tools.length, 0);
        await request('/api/servers/external', admin, 'DELETE');
        assert.ok(
          !(await (await request('/api/grants')).json()).some(
            (grant: { serverId: string }) => grant.serverId === 'external',
          ),
        );
        assert.equal((await request('/api/servers/alpha', admin, 'DELETE')).status, 403);
      },
    );
    await t.test(
      'invalid grant targets, unknown members and duplicate rules do not modify existing permissions',
      async () => {
        assert.equal(
          (
            await request('/api/groups', admin, 'POST', {
              name: 'Invalid',
              members: ['missing-user'],
            })
          ).status,
          400,
        );
        assert.equal(
          (await request('/api/grants/user/unknown', admin, 'PUT', { grants: [] })).status,
          404,
        );
        assert.equal(
          (
            await request('/api/grants/user/alice', admin, 'PUT', {
              grants: [{ serverId: 'unknown', effect: 'allow' }],
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await request('/api/grants/user/alice', admin, 'PUT', {
              grants: [
                { serverId: 'alpha', effect: 'allow' },
                { serverId: 'alpha', effect: 'deny' },
              ],
            })
          ).status,
          400,
        );
        assert.equal((await mcp(alice)).result.tools.length, 1);
      },
    );
  },
);
