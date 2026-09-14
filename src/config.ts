import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { z } from 'zod';

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const httpUrl = z.url().refine((value) => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash;
}, 'An HTTP(S) URL without credentials or fragment is required');
const scope = z.string().regex(/^[\x21\x23-\x5B\x5D-\x7E]+$/);
export const policySchema = z.strictObject({
  anyRole: z.array(z.string().min(1)).default([]),
  allScopes: z.array(scope).default([]),
  allowAuthenticated: z.boolean().default(false),
});
export type Policy = z.infer<typeof policySchema>;
const access = {
  policy: policySchema.optional(),
  tools: z.record(z.string().min(1), policySchema).default({}),
};
const externalAuth = z
  .discriminatedUnion('type', [
    z.strictObject({ type: z.literal('none') }),
    z.strictObject({ type: z.literal('bearer'), tokenEnv: envName }),
    z.strictObject({
      type: z.literal('apiKey'),
      header: z
        .string()
        .regex(/^[a-zA-Z0-9-]+$/)
        .refine(
          (value) =>
            !/^(host|cookie|authorization|content-type|content-length|connection|transfer-encoding|mcp-.*)$/i.test(
              value,
            ),
          'Reserved header',
        ),
      valueEnv: envName,
    }),
    z.strictObject({
      type: z.literal('clientCredentials'),
      tokenUrl: httpUrl,
      clientId: z.string().min(1),
      clientSecretEnv: envName,
      scopes: z.array(scope).default([]),
      resource: httpUrl.optional(),
    }),
  ])
  .default({ type: 'none' });
export const serverSchema = z.discriminatedUnion('transport', [
  z.strictObject({
    transport: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    envFrom: z.record(z.string(), envName).default({}),
    ...access,
  }),
  z.strictObject({ transport: z.literal('http'), url: httpUrl, auth: externalAuth, ...access }),
]);
const authSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('disabled') }),
  z.strictObject({
    mode: z.literal('keycloak'),
    issuer: httpUrl,
    clientId: z.string().min(1).default('mcp-gateway'),
    requiredScopes: z.array(scope).default(['mcp:access']),
    algorithms: z
      .array(z.enum(['RS256', 'RS384', 'RS512', 'ES256']))
      .min(1)
      .default(['RS256']),
  }),
]);
export const configSchema = z
  .strictObject({
    mode: z.enum(['development', 'production']).default('production'),
    host: z.enum(['127.0.0.1', '0.0.0.0', '::1', '::']).default('127.0.0.1'),
    trustedProxies: z
      .array(
        z.string().refine((value) => {
          const [address, prefix, extra] = value.split('/');
          const version = isIP(address);
          return (
            !!version &&
            extra === undefined &&
            (prefix === undefined ||
              (/^\d+$/.test(prefix) && Number(prefix) <= (version === 4 ? 32 : 128)))
          );
        }, 'Use an explicit proxy IP address or CIDR'),
      )
      .default([]),
    port: z.number().int().min(0).max(65535).default(3000),
    publicUrl: httpUrl.default('http://127.0.0.1:3000/mcp'),
    allowedOrigins: z.array(httpUrl).default([]),
    timeoutMs: z.number().int().min(100).max(120000).default(30000),
    maxConcurrentRequests: z.number().int().min(1).max(1000).default(50),
    rateLimitPerMinute: z.number().int().positive().default(120),
    auth: authSchema,
    console: z
      .strictObject({
        enabled: z.boolean().default(false),
        databasePath: z.string().min(1).default('data/gateway.sqlite'),
        clientId: z.string().min(1).default('mcp-console'),
        adminRole: z.string().min(1).default('client:gateway-admin'),
        credentialEnvs: z.array(envName).default([]),
        allowedUpstreamOrigins: z.array(httpUrl).default([]),
        directory: z
          .strictObject({ clientId: z.string().min(1), clientSecretEnv: envName })
          .optional(),
      })
      .default({
        enabled: false,
        databasePath: 'data/gateway.sqlite',
        clientId: 'mcp-console',
        adminRole: 'client:gateway-admin',
        credentialEnvs: [],
        allowedUpstreamOrigins: [],
      }),
    servers: z
      .record(z.string().regex(/^[a-zA-Z0-9-]+$/), serverSchema)
      .refine((value) => Object.keys(value).length > 0, 'At least one server is required'),
  })
  .superRefine((config, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (process.env.NODE_ENV === 'production' && config.mode !== 'production')
      issue('NODE_ENV=production requires production mode');
    const publicUrl = new URL(config.publicUrl);
    if (publicUrl.pathname !== '/mcp' || publicUrl.search)
      issue('publicUrl must end in /mcp without query parameters');
    for (const origin of config.allowedOrigins) {
      if (new URL(origin).origin !== origin)
        issue('allowedOrigins must contain exact origins without trailing slashes');
    }
    if (config.auth.mode === 'keycloak') {
      const issuer = new URL(config.auth.issuer);
      if (issuer.search || issuer.pathname.endsWith('/'))
        issue('Keycloak issuer must not have a query or trailing slash');
    }
    if (
      config.auth.mode === 'disabled' &&
      (config.mode !== 'development' || !['127.0.0.1', '::1'].includes(config.host))
    ) {
      issue('Authentication can only be disabled in loopback development mode');
    }
    if (config.mode === 'production') {
      const urls = [
        config.publicUrl,
        ...config.allowedOrigins,
        ...config.console.allowedUpstreamOrigins,
      ];
      if (config.auth.mode === 'keycloak') urls.push(config.auth.issuer);
      for (const upstream of Object.values(config.servers)) {
        if (upstream.transport === 'http') {
          urls.push(upstream.url);
          if (upstream.auth.type === 'clientCredentials') urls.push(upstream.auth.tokenUrl);
        }
      }
      if (urls.some((url) => new URL(url).protocol !== 'https:'))
        issue('Production public, issuer, origin and upstream URLs must use HTTPS');
    }
  });
export type Config = z.infer<typeof configSchema>;
export type Upstream = Config['servers'][string];
export function readSecret(name: string): string {
  const value = process.env[name];
  if (!value || /[\r\n]/.test(value))
    throw new Error(`Missing or invalid environment variable: ${name}`);
  return value;
}
export async function loadConfig(path: string): Promise<Config> {
  const text = await readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON in gateway configuration');
  }
  return configSchema.parse(parsed);
}
