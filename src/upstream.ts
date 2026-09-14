import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { readSecret, type Config, type Upstream } from './config.js';

const tokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().regex(/^bearer$/i),
  expires_in: z.number().positive().finite(),
});

/** Service credentials are scoped to one administrator-configured upstream. */
export function createUpstreamFetch(
  upstream: Extract<Upstream, { transport: 'http' }>,
  timeoutMs: number,
): typeof fetch {
  const auth = upstream.auth;
  let cached: { token: string; refreshAt: number } | undefined;
  let pending: Promise<string> | undefined;
  if (auth.type === 'bearer') readSecret(auth.tokenEnv);
  if (auth.type === 'apiKey') readSecret(auth.valueEnv);
  if (auth.type === 'clientCredentials') readSecret(auth.clientSecretEnv);
  const serviceToken = async (): Promise<string> => {
    if (auth.type !== 'clientCredentials') throw new Error('Invalid credential type');
    if (cached && cached.refreshAt > Date.now()) return cached.token;
    if (!pending) {
      pending = (async () => {
        const body = new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: auth.clientId,
          client_secret: readSecret(auth.clientSecretEnv),
        });
        if (auth.scopes.length) body.set('scope', auth.scopes.join(' '));
        if (auth.resource) body.set('resource', auth.resource);
        const response = await fetch(auth.tokenUrl, {
          method: 'POST',
          body,
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error('Upstream token request failed');
        }
        const token = tokenSchema.parse(await response.json());
        cached = {
          token: token.access_token,
          refreshAt: Date.now() + token.expires_in * 1000 - Math.min(30000, token.expires_in * 100),
        };
        return cached.token;
      })().finally(() => {
        pending = undefined;
      });
    }
    return pending;
  };
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.href !== new URL(upstream.url).href)
      throw new Error('Upstream credential destination mismatch');
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    headers.delete('authorization');
    headers.delete('cookie');
    if (auth.type === 'bearer') headers.set('Authorization', `Bearer ${readSecret(auth.tokenEnv)}`);
    if (auth.type === 'apiKey') headers.set(auth.header, readSecret(auth.valueEnv));
    if (auth.type === 'clientCredentials')
      headers.set('Authorization', `Bearer ${await serviceToken()}`);
    const response = await fetch(input, { ...init, headers, redirect: 'error' });
    // A later request obtains a fresh token. Never replay an operation that may have side effects.
    if (response.status === 401) cached = undefined;
    return response;
  };
}

export class UpstreamConnections {
  private readonly fetchers = new Map<string, typeof fetch>();
  private readonly clients = new Set<Client>();
  private readonly shutdown = new AbortController();
  constructor(private readonly config: Config) {
    for (const [name, upstream] of Object.entries(config.servers)) {
      if (upstream.transport === 'http')
        this.fetchers.set(name, createUpstreamFetch(upstream, config.timeoutMs));
      else for (const env of Object.values(upstream.envFrom)) readSecret(env);
    }
  }
  async use<T>(
    name: string,
    operation: (client: Client, signal: AbortSignal) => Promise<T>,
    incoming?: AbortSignal,
  ): Promise<T> {
    const upstream = this.config.servers[name];
    if (!upstream) throw new Error('Unknown upstream');
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      this.shutdown.signal,
      AbortSignal.timeout(this.config.timeoutMs),
      ...(incoming ? [incoming] : []),
    ]);
    signal.throwIfAborted();
    const client = new Client({ name: 'mcp-gateway', version: '0.2.0' });
    const transport =
      upstream.transport === 'stdio'
        ? new StdioClientTransport({
            command: upstream.command,
            args: upstream.args,
            cwd: upstream.cwd,
            env: {
              ...upstream.env,
              ...Object.fromEntries(
                Object.entries(upstream.envFrom).map(([key, env]) => [key, readSecret(env)]),
              ),
            },
            stderr: 'ignore',
          })
        : new StreamableHTTPClientTransport(new URL(upstream.url), {
            fetch: (input, init) =>
              this.fetchers.get(name)!(input, {
                ...init,
                signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
              }),
            reconnectionOptions: {
              maxRetries: 0,
              initialReconnectionDelay: 1000,
              maxReconnectionDelay: 1000,
              reconnectionDelayGrowFactor: 1,
            },
          });
    this.clients.add(client);
    try {
      await client.connect(transport, { timeout: this.config.timeoutMs, signal });
      return await operation(client, signal);
    } finally {
      if (
        transport instanceof StreamableHTTPClientTransport &&
        transport.sessionId &&
        !signal.aborted
      ) {
        // Cleanup also shares the operation's deadline.
        await transport.terminateSession().catch(() => {});
      }
      controller.abort();
      await client.close().catch(() => {});
      this.clients.delete(client);
    }
  }
  async close(): Promise<void> {
    this.shutdown.abort();
    await Promise.allSettled([...this.clients].map((client) => client.close()));
    this.clients.clear();
  }
}
