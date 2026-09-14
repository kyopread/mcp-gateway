import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import { generateKeyPair, exportJWK, SignJWT, type JWTPayload } from 'jose';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export async function serve(app: Express) {
  const http = app.listen(0, '127.0.0.1');
  await once(http, 'listening');
  return {
    origin: `http://127.0.0.1:${(http.address() as { port: number }).port}`,
    close: async () => {
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
export async function identityProvider() {
  const keys = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const app = express();
  let jwksRequests = 0;
  app.get('/realms/test/protocol/openid-connect/certs', (_req, res) => {
    jwksRequests++;
    res.json({ keys: [jwk] });
  });
  const http = await serve(app);
  const issuer = `${http.origin}/realms/test`;
  return {
    ...http,
    issuer,
    jwksRequests: () => jwksRequests,
    token: async (overrides: JWTPayload = {}, signingKey = keys.privateKey) => {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({
        sub: 'alice',
        iss: issuer,
        aud: 'http://127.0.0.1:3000/mcp',
        iat: now,
        exp: now + 300,
        typ: 'Bearer',
        scope: 'mcp:access',
        resource_access: { 'mcp-gateway': { roles: ['reader'] } },
        ...overrides,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .sign(signingKey);
    },
  };
}

export async function externalMcp(expected: { header: string; value: string }) {
  const app = express();
  app.use(express.json());
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: McpServer }
  >();
  const observed: { authorization?: string; apiKey?: string; meta?: unknown }[] = [];
  let calls = 0;
  let delayMs = 0;
  app.all('/mcp', async (req, res) => {
    observed.push({
      authorization: req.headers.authorization,
      apiKey: req.get('x-api-key'),
      meta: req.body?.params?._meta,
    });
    if (req.get(expected.header) !== expected.value) {
      res.status(401).end();
      return;
    }
    const session = req.get('mcp-session-id');
    if (session && sessions.has(session)) {
      await sessions.get(session)!.transport.handleRequest(req, res, req.body);
      return;
    }
    if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
      res.status(400).end();
      return;
    }
    const server = new McpServer({ name: 'external', version: '1.0.0' });
    let sessionCalls = 0;
    server.registerTool('echo', { inputSchema: { text: z.string() } }, async ({ text }) => {
      calls++;
      sessionCalls++;
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { content: [{ type: 'text', text: `${sessionCalls}: ${text}` }] };
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  const http = await serve(app);
  return {
    origin: http.origin,
    observed,
    calls: () => calls,
    sessions: () => sessions.size,
    delay: (ms: number) => {
      delayMs = ms;
    },
    close: async () => {
      await Promise.allSettled([...sessions.values()].map(({ server }) => server.close()));
      await http.close();
    },
  };
}
