import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { configSchema, type Config, type Upstream } from './config.js';
import { permits, type Principal } from './auth.js';
import { Store, type ServerRecord } from './store.js';
import { UpstreamConnections } from './upstream.js';

export type Route = { upstream: string; originalName: string; tool: Tool };
type Entry = {
  record: ServerRecord;
  connections: UpstreamConnections;
  routes: Route[];
  status: 'ready' | 'disabled';
};
export class Registry {
  private entries = new Map<string, Entry>();
  private writing = false;
  constructor(
    readonly config: Config,
    readonly store: Store,
  ) {}
  async start() {
    for (const record of this.store.servers()) {
      if (record.source === 'file' && !Object.hasOwn(this.config.servers, record.id))
        this.store.deleteServer(record.id);
    }
    for (const [id, upstream] of Object.entries(this.config.servers)) {
      const existing = this.store.servers().find((record) => record.id === id);
      if (existing?.source === 'console')
        throw new Error(`Server ID conflicts with configuration: ${id}`);
      this.store.saveServer({
        id,
        name: id,
        description: '설정 파일에서 관리하는 MCP 서버',
        enabled: existing?.enabled ?? true,
        source: 'file',
        upstream,
      });
    }
    try {
      for (const record of this.store.servers())
        this.entries.set(record.id, await this.prepare(record));
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  private async prepare(record: ServerRecord): Promise<Entry> {
    const config = configSchema.parse({
      ...this.config,
      servers: { [record.id]: record.upstream },
    });
    const connections = new UpstreamConnections(config);
    const routes: Route[] = [];
    if (!record.enabled) return { record, connections, routes, status: 'disabled' };
    try {
      await connections.use(record.id, async (client, signal) => {
        let cursor: string | undefined;
        const cursors = new Set<string>();
        let pages = 0;
        do {
          if (++pages > 100) throw new Error('Tool catalog pagination limit exceeded');
          const page = await client.listTools({ cursor }, { signal, timeout: config.timeoutMs });
          for (const tool of page.tools) {
            const name = `${record.id}__${tool.name}`;
            if (
              name.length > 128 ||
              !/^[a-zA-Z0-9_.-]+$/.test(name) ||
              routes.some((route) => route.tool.name === name) ||
              routes.length >= 10000
            ) {
              throw new Error('Invalid tool catalog');
            }
            routes.push({ upstream: record.id, originalName: tool.name, tool: { ...tool, name } });
          }
          cursor = page.nextCursor;
          if (cursor && cursors.has(cursor)) throw new Error('Repeated tools cursor');
          if (cursor) cursors.add(cursor);
        } while (cursor);
      });
    } catch {
      await connections.close();
      throw new Error(`Upstream catalog initialization failed: ${record.id}`);
    }
    return { record, connections, routes, status: 'ready' };
  }
  routes(): Route[] {
    return [...this.entries.values()].flatMap((entry) => entry.routes);
  }
  allowed(principal: Principal, route: Route): boolean {
    const record = this.entries.get(route.upstream)?.record;
    if (!record?.enabled) return false;
    if (this.config.auth.mode === 'disabled') return true;
    const decision = this.store.decision(principal, record.id);
    if (decision === 'deny') return false;
    return (
      (decision === 'allow' || permits(principal, record.upstream.policy)) &&
      (!Object.hasOwn(record.upstream.tools, route.originalName) ||
        permits(principal, record.upstream.tools[route.originalName]))
    );
  }
  servers() {
    return [...this.entries.values()].map((entry) => ({
      ...entry.record,
      status: entry.status,
      toolCount: entry.routes.length,
      toolNames: entry.routes.map((route) => route.originalName),
    }));
  }
  async call(route: Route, args: Record<string, unknown> | undefined, signal: AbortSignal) {
    const entry = this.entries.get(route.upstream);
    if (!entry?.record.enabled) throw new Error('Server unavailable');
    return entry.connections.use(
      route.upstream,
      (client, incoming) =>
        client.callTool({ name: route.originalName, arguments: args }, undefined, {
          signal: incoming,
          timeout: this.config.timeoutMs,
        }),
      signal,
    );
  }
  async save(record: ServerRecord) {
    if (this.writing) throw new Error('Another server update is in progress');
    this.writing = true;
    let prepared: Entry | undefined;
    try {
      prepared = await this.prepare(record);
      this.store.saveServer(record);
      const previous = this.entries.get(record.id);
      this.entries.set(record.id, prepared);
      await previous?.connections.close();
    } catch (error) {
      if (prepared && this.entries.get(record.id) !== prepared) await prepared.connections.close();
      throw error;
    } finally {
      this.writing = false;
    }
  }
  async remove(id: string) {
    if (this.writing) throw new Error('Another server update is in progress');
    const previous = this.entries.get(id);
    this.store.deleteServer(id);
    this.entries.delete(id);
    await previous?.connections.close();
  }
  async close() {
    await Promise.allSettled([...this.entries.values()].map((entry) => entry.connections.close()));
  }
}
