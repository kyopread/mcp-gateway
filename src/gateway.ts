import { resolve } from 'node:path';
import { ZodError } from 'zod';
import { Store } from './store.js';
import { Registry } from './registry.js';
import { consoleApi } from './console-api.js';
import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import pino, { type Logger } from 'pino';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { configSchema, type Config } from './config.js';
import { createAuth, type Principal } from './auth.js';

export async function createGateway(input: Config, options: { logger?: Logger } = {}) {
  const config = configSchema.parse(input);
  const logger = options.logger ?? pino({ level: process.env.LOG_LEVEL ?? 'info' });
  const store = new Store(config.console.enabled ? config.console.databasePath : ':memory:');
  const registry = new Registry(config, store);
  const active = new Set<Server>();
  let stopping = false;
  let closed = false;
  const close = async () => {
    if (closed) return;
    stopping = true;
    await registry.close();
    await Promise.allSettled([...active].map((server) => server.close()));
    store.close();
    closed = true;
  };
  try {
    await registry.start();
  } catch (error) {
    await close();
    throw error;
  }
  const auth = createAuth(config);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustedProxies.length ? config.trustedProxies : false);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          connectSrc: [
            "'self'",
            ...(config.auth.mode === 'keycloak' ? [new URL(config.auth.issuer).origin] : []),
          ],
          frameSrc: ["'none'"],
          upgradeInsecureRequests: config.mode === 'development' ? null : [],
        },
      },
    }),
  );
  app.use((req, res, next) => {
    res.locals.requestId = randomUUID();
    res.set('X-Request-Id', res.locals.requestId);
    const start = Date.now();
    res.on('finish', () => {
      logger.info(
        {
          event: 'http_request',
          requestId: res.locals.requestId,
          method: req.method,
          endpoint: req.path === '/mcp' ? '/mcp' : 'other',
          status: res.statusCode,
          durationMs: Date.now() - start,
        },
        'HTTP request completed',
      );
    });
    next();
  });
  app.use(
    hostHeaderValidation([new URL(config.publicUrl).hostname, '127.0.0.1', 'localhost', '[::1]']),
  );
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ![new URL(config.publicUrl).origin, ...config.allowedOrigins].includes(origin)) {
      res.status(403).json({ error: 'origin_not_allowed' });
      return;
    }
    if (origin) {
      res.set('Access-Control-Allow-Origin', origin).vary('Origin');
      res.set(
        'Access-Control-Expose-Headers',
        'WWW-Authenticate, MCP-Protocol-Version, X-Request-Id',
      );
    }
    if (req.method === 'OPTIONS' && (req.path === '/mcp' || req.path.startsWith('/api/'))) {
      res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
      res.set(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, Accept, MCP-Protocol-Version',
      );
      res.status(204).end();
      return;
    }
    next();
  });
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/ready', (_req, res) =>
    res.status(stopping ? 503 : 200).json({ status: stopping ? 'stopping' : 'ready' }),
  );
  if (auth.metadata) {
    app.get(
      ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'],
      (_req, res) => res.json(auth.metadata),
    );
  }
  if (config.console.enabled) {
    app.get('/api/config', (_req, res) =>
      res.json({
        mode: config.auth.mode,
        publicUrl: config.publicUrl,
        clientId: config.console.clientId,
        issuer: config.auth.mode === 'keycloak' ? config.auth.issuer : null,
        scope: config.auth.mode === 'keycloak' ? config.auth.requiredScopes.join(' ') : '',
      }),
    );
    app.use(
      '/api',
      rateLimit({
        windowMs: 60000,
        limit: config.rateLimitPerMinute * 2,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        message: { error: 'rate_limit_exceeded' },
      }),
    );
    app.use('/api', auth.middleware, express.json({ limit: '1mb' }));
    app.use('/api', consoleApi(config, registry, store));
    app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));
    app.use(express.static(resolve('dist/public'), { index: false }));
    app.get(['/', '/auth/callback'], (_req, res) =>
      res.sendFile(resolve('dist/public/index.html')),
    );
  }
  app.use(
    '/mcp',
    rateLimit({
      windowMs: 60000,
      limit: config.rateLimitPerMinute,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: 'rate_limit_exceeded' },
    }),
  );
  app.use('/mcp', auth.middleware);
  let inFlight = 0;
  app.use('/mcp', (_req, res, next) => {
    if (stopping || inFlight >= config.maxConcurrentRequests) {
      res.set('Retry-After', '1').status(503).json({ error: 'gateway_unavailable' });
      return;
    }
    inFlight++;
    res.on('close', () => {
      inFlight--;
    });
    next();
  });
  app.use('/mcp', express.json({ limit: '1mb' }));
  app.post('/mcp', async (req, res) => {
    const principal = res.locals.principal as Principal;
    const server = new Server(
      { name: 'mcp-gateway', version: '0.2.0' },
      { capabilities: { tools: {} } },
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const disconnected = new AbortController();
    active.add(server);
    res.on('close', () => {
      disconnected.abort();
      active.delete(server);
      void server.close().catch(() => {});
    });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: registry
        .routes()
        .filter((route) => registry.allowed(principal, route))
        .map((route) => route.tool),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const route = registry.routes().find((route) => route.tool.name === request.params.name);
      const audit = {
        event: 'tool_call',
        requestId: res.locals.requestId,
        subject: principal.subject,
        tool: route?.tool.name ?? '[unavailable]',
        upstream: route?.upstream,
      };
      if (!route || !registry.allowed(principal, route)) {
        logger.warn({ ...audit, outcome: 'denied' }, 'Tool access denied');
        if (!closed) store.audit(principal.subject, 'tool.call', audit.tool, 'denied');
        throw new McpError(ErrorCode.InvalidParams, 'Tool unavailable or access denied');
      }
      const started = Date.now();
      try {
        const result = await registry.call(
          route,
          request.params.arguments,
          AbortSignal.any([extra.signal, disconnected.signal]),
        );
        if (!closed)
          store.audit(
            principal.subject,
            'tool.call',
            audit.tool,
            result.isError ? 'tool_error' : 'success',
          );
        logger.info(
          {
            ...audit,
            outcome: result.isError ? 'tool_error' : 'success',
            durationMs: Date.now() - started,
          },
          'Tool call completed',
        );
        return result;
      } catch {
        if (!closed) store.audit(principal.subject, 'tool.call', audit.tool, 'upstream_error');
        logger.error(
          { ...audit, outcome: 'upstream_error', durationMs: Date.now() - started },
          'Upstream call failed',
        );
        throw new McpError(ErrorCode.InternalError, 'Upstream call failed');
      }
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      logger.error({ event: 'mcp_error', requestId: res.locals.requestId }, 'MCP request failed');
      if (!res.headersSent)
        res
          .status(500)
          .json({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32603, message: 'Gateway request failed' },
          });
      else res.end();
      await server.close().catch(() => {});
      active.delete(server);
    }
  });
  app.all('/mcp', (_req, res) =>
    res
      .status(405)
      .set('Allow', 'POST')
      .json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'Method not allowed' },
      }),
  );
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    const status =
      error instanceof ZodError
        ? 400
        : error.type === 'entity.too.large'
          ? 413
          : error.type === 'entity.parse.failed'
            ? 400
            : 500;
    res
      .status(status)
      .json({
        error:
          status === 413
            ? 'payload_too_large'
            : status === 400
              ? error instanceof ZodError
                ? 'invalid_request'
                : 'invalid_json'
              : 'internal_error',
      });
  };
  app.use(errors);
  return { app, close };
}
