import { Router } from 'express';
import { z } from 'zod';
import type { Config } from './config.js';
import { serverSchema } from './config.js';
import type { Principal } from './auth.js';
import type { Registry } from './registry.js';
import type { Store } from './store.js';
import { fetchDirectoryUsers } from './directory.js';

const label = z.string().trim().min(1).max(100);
const userInput = z.strictObject({
  id: z.string().trim().min(1).max(200),
  username: label,
  email: z.string().max(254).default(''),
  enabled: z.boolean().default(true),
});
const groupInput = z.strictObject({
  name: label,
  description: z.string().max(500).default(''),
  members: z.array(z.string()).max(10000).default([]),
});
const serverInput = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9-]{1,48}$/),
  name: label,
  description: z.string().max(500).default(''),
  enabled: z.boolean().default(true),
  upstream: serverSchema,
});
const grantInput = z.strictObject({
  grants: z
    .array(z.strictObject({ serverId: z.string(), effect: z.enum(['allow', 'deny']) }))
    .max(1000),
});

export function consoleApi(config: Config, registry: Registry, store: Store) {
  const api = Router();
  const admin = (principal: Principal) => principal.roles.has(config.console.adminRole);
  const publicServer = (server: ReturnType<Registry['servers']>[number], isAdmin: boolean) => ({
    id: server.id,
    name: server.name,
    description: server.description,
    enabled: server.enabled,
    source: server.source,
    status: server.status,
    toolCount: server.toolCount,
    toolNames: server.toolNames,
    transport: server.upstream.transport,
    ...(isAdmin
      ? {
          upstream:
            server.upstream.transport === 'http'
              ? server.upstream
              : {
                  transport: 'stdio',
                  policy: server.upstream.policy,
                  tools: server.upstream.tools,
                },
        }
      : {}),
  });
  api.get('/me', (_req, res) => {
    const principal = res.locals.principal as Principal;
    store.upsertUser({
      id: principal.subject,
      username: principal.username,
      email: principal.email,
      enabled: true,
    });
    res.json({
      id: principal.subject,
      username: principal.username,
      email: principal.email,
      admin: admin(principal),
      roles: [...principal.roles],
      groups: store
        .groups()
        .filter((group) => group.members.includes(principal.subject))
        .map((group) => ({ id: group.id, name: group.name })),
      publicUrl: config.publicUrl,
      directoryEnabled: !!config.console.directory,
      credentialEnvs: admin(principal) ? config.console.credentialEnvs : [],
      allowedUpstreamOrigins: admin(principal) ? config.console.allowedUpstreamOrigins : [],
    });
  });
  api.get('/servers', (_req, res) => {
    const principal = res.locals.principal as Principal;
    const isAdmin = admin(principal);
    const visible = registry
      .servers()
      .filter(
        (server) =>
          isAdmin ||
          registry
            .routes()
            .some((route) => route.upstream === server.id && registry.allowed(principal, route)),
      );
    res.json(
      visible.map((server) =>
        publicServer(
          {
            ...server,
            ...(!isAdmin
              ? {
                  toolNames: registry
                    .routes()
                    .filter(
                      (route) => route.upstream === server.id && registry.allowed(principal, route),
                    )
                    .map((route) => route.originalName),
                  toolCount: registry
                    .routes()
                    .filter(
                      (route) => route.upstream === server.id && registry.allowed(principal, route),
                    ).length,
                }
              : {}),
          },
          isAdmin,
        ),
      ),
    );
  });
  api.use((_req, res, next) => {
    if (!admin(res.locals.principal)) {
      res.status(403).json({ error: 'admin_required' });
      return;
    }
    next();
  });
  api.get('/users', (_req, res) => res.json(store.users()));
  api.get('/groups', (_req, res) => res.json(store.groups()));
  api.get('/grants', (_req, res) => res.json(store.grants()));
  api.get('/audit', (_req, res) => res.json(store.events()));
  api.post('/users', (req, res) => {
    const user = userInput.parse(req.body);
    store.upsertUser(user);
    store.audit(res.locals.principal.subject, 'user.register', user.username);
    res.status(201).json(user);
  });
  let syncing = false;
  api.post('/directory/sync', async (_req, res) => {
    if (syncing) {
      res.status(409).json({ error: 'sync_in_progress' });
      return;
    }
    syncing = true;
    try {
      const users = await fetchDirectoryUsers(config);
      store.transaction(() => {
        for (const user of users) store.upsertUser(user);
      });
      store.audit(res.locals.principal.subject, 'directory.sync', String(users.length));
      res.json({ count: users.length });
    } catch {
      res.status(502).json({ error: 'directory_sync_failed' });
    } finally {
      syncing = false;
    }
  });
  const checkMembers = (members: string[]) => {
    const ids = new Set(store.users().map((user) => user.id));
    if (members.some((id) => !ids.has(id)))
      throw new z.ZodError([{ code: 'custom', path: ['members'], message: 'Unknown member' }]);
  };
  api.post('/groups', (req, res) => {
    const group = groupInput.parse(req.body);
    checkMembers(group.members);
    if (store.groups().some((item) => item.name === group.name)) {
      res.status(409).json({ error: 'group_exists' });
      return;
    }
    const id = store.saveGroup(group);
    store.audit(res.locals.principal.subject, 'group.create', group.name);
    res.status(201).json({ id });
  });
  api.put('/groups/:id', (req, res) => {
    const id = String(req.params.id);
    const group = groupInput.parse(req.body);
    checkMembers(group.members);
    if (!store.groups().some((item) => item.id === id)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (store.groups().some((item) => item.name === group.name && item.id !== id)) {
      res.status(409).json({ error: 'group_exists' });
      return;
    }
    store.saveGroup({ ...group, id });
    store.audit(res.locals.principal.subject, 'group.update', group.name);
    res.json({ id });
  });
  api.delete('/groups/:id', (req, res) => {
    const id = String(req.params.id);
    store.deleteGroup(id);
    store.audit(res.locals.principal.subject, 'group.delete', id);
    res.status(204).end();
  });
  api.put('/grants/:kind/:id', (req, res) => {
    const kind = z.enum(['user', 'group']).parse(req.params.kind);
    const subjectId = String(req.params.id);
    const { grants } = grantInput.parse(req.body);
    const subjects = kind === 'user' ? store.users() : store.groups();
    if (!subjects.some((item) => item.id === subjectId)) {
      res.status(404).json({ error: 'subject_not_found' });
      return;
    }
    const servers = new Set(registry.servers().map((server) => server.id));
    if (
      new Set(grants.map((grant) => grant.serverId)).size !== grants.length ||
      grants.some((grant) => !servers.has(grant.serverId))
    ) {
      res.status(400).json({ error: 'invalid_grants' });
      return;
    }
    store.setGrants(kind, subjectId, grants);
    store.audit(
      res.locals.principal.subject,
      `permissions.${kind}.update`,
      subjects.find((item) => item.id === subjectId)
        ? 'username' in subjects.find((item) => item.id === subjectId)!
          ? (subjects.find((item) => item.id === subjectId) as { username: string }).username
          : (subjects.find((item) => item.id === subjectId) as { name: string }).name
        : subjectId,
    );
    res.json({ saved: true });
  });
  const validateUpstream = (input: z.infer<typeof serverInput>) => {
    const upstream = input.upstream;
    if (upstream.transport !== 'http') throw new Error('Web registration supports HTTP only');
    if (config.mode === 'production') {
      const urls = [
        upstream.url,
        ...(upstream.auth.type === 'clientCredentials' ? [upstream.auth.tokenUrl] : []),
      ];
      if (urls.some((url) => !config.console.allowedUpstreamOrigins.includes(new URL(url).origin)))
        throw new Error('Upstream origin is not approved');
    }
    const names =
      upstream.auth.type === 'bearer'
        ? [upstream.auth.tokenEnv]
        : upstream.auth.type === 'apiKey'
          ? [upstream.auth.valueEnv]
          : upstream.auth.type === 'clientCredentials'
            ? [upstream.auth.clientSecretEnv]
            : [];
    if (names.some((name) => !config.console.credentialEnvs.includes(name)))
      throw new Error('Credential reference is not approved');
  };
  api.post('/servers', async (req, res) => {
    const input = serverInput.parse(req.body);
    if (registry.servers().some((server) => server.id === input.id)) {
      res.status(409).json({ error: 'server_exists' });
      return;
    }
    try {
      validateUpstream(input);
      await registry.save({ ...input, source: 'console' });
      store.audit(res.locals.principal.subject, 'server.create', input.id);
      res.status(201).json({ id: input.id });
    } catch {
      res.status(422).json({ error: 'server_connection_failed' });
    }
  });
  api.put('/servers/:id', async (req, res) => {
    const input = serverInput.parse(req.body);
    const previous = registry.servers().find((server) => server.id === req.params.id);
    if (!previous) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (previous.source === 'file' || input.id !== previous.id) {
      res.status(403).json({ error: 'file_server_readonly' });
      return;
    }
    try {
      validateUpstream(input);
      await registry.save({ ...input, source: 'console' });
      store.audit(res.locals.principal.subject, 'server.update', input.id);
      res.json({ saved: true });
    } catch {
      res.status(422).json({ error: 'server_connection_failed' });
    }
  });
  api.post('/servers/:id/refresh', async (req, res) => {
    const previous = registry.servers().find((server) => server.id === req.params.id);
    if (!previous) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    try {
      await registry.save(previous);
      store.audit(res.locals.principal.subject, 'server.refresh', previous.id);
      res.json({ refreshed: true });
    } catch {
      res.status(502).json({ error: 'server_connection_failed' });
    }
  });
  api.delete('/servers/:id', async (req, res) => {
    const previous = registry.servers().find((server) => server.id === req.params.id);
    if (!previous) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (previous.source === 'file') {
      res.status(403).json({ error: 'file_server_readonly' });
      return;
    }
    await registry.remove(previous.id);
    store.audit(res.locals.principal.subject, 'server.delete', previous.id);
    res.status(204).end();
  });
  return api;
}
