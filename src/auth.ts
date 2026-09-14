import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { RequestHandler } from 'express';
import type { Config, Policy } from './config.js';

export type Principal = {
  subject: string;
  username: string;
  email: string;
  groups: Set<string>;
  roles: Set<string>;
  scopes: Set<string>;
};
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function principalFromClaims(payload: JWTPayload, clientId: string): Principal {
  return {
    subject: payload.sub!,
    username:
      typeof payload.preferred_username === 'string' ? payload.preferred_username : payload.sub!,
    email: typeof payload.email === 'string' ? payload.email : '',
    groups: new Set(strings(payload.groups)),
    roles: new Set([
      ...strings(object(payload.realm_access).roles).map((role) => `realm:${role}`),
      ...strings(object(object(payload.resource_access)[clientId]).roles).map(
        (role) => `client:${role}`,
      ),
    ]),
    scopes: new Set(
      typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [],
    ),
  };
}
export function permits(principal: Principal, policy: Policy | undefined): boolean {
  if (
    !policy ||
    (!policy.allowAuthenticated && policy.anyRole.length === 0 && policy.allScopes.length === 0)
  )
    return false;
  return (
    (policy.anyRole.length === 0 || policy.anyRole.some((role) => principal.roles.has(role))) &&
    policy.allScopes.every((scope) => principal.scopes.has(scope))
  );
}
export function createAuth(config: Config): {
  middleware: RequestHandler;
  metadata: Record<string, unknown> | undefined;
} {
  const auth = config.auth;
  if (auth.mode === 'disabled')
    return {
      middleware: (_req, res, next) => {
        res.locals.principal = {
          subject: 'development',
          username: '로컬 관리자',
          email: '',
          groups: new Set(),
          roles: new Set([config.console.adminRole]),
          scopes: new Set(),
        } satisfies Principal;
        next();
      },
      metadata: undefined,
    };
  const jwks = createRemoteJWKSet(new URL(`${auth.issuer}/protocol/openid-connect/certs`), {
    timeoutDuration: Math.min(config.timeoutMs, 5000),
    cooldownDuration: 30000,
    cacheMaxAge: 600000,
  });
  const metadataUrl = new URL('/.well-known/oauth-protected-resource/mcp', config.publicUrl).href;
  const challenge = `Bearer resource_metadata="${metadataUrl}"`;
  return {
    metadata: {
      resource: config.publicUrl,
      authorization_servers: [auth.issuer],
      scopes_supported: [
        ...new Set([
          ...auth.requiredScopes,
          ...Object.values(config.servers).flatMap((server) =>
            [server.policy, ...Object.values(server.tools)].flatMap(
              (policy) => policy?.allScopes ?? [],
            ),
          ),
        ]),
      ],
      bearer_methods_supported: ['header'],
    },
    middleware: async (req, res, next) => {
      res.set('Cache-Control', 'no-store');
      const header = req.headers.authorization;
      if (!header || !/^Bearer [^\s]+$/i.test(header) || header.length > 16384) {
        res.set('WWW-Authenticate', challenge).status(401).json({ error: 'unauthorized' });
        return;
      }
      try {
        const { payload } = await jwtVerify(header.slice(7), jwks, {
          issuer: auth.issuer,
          audience: config.publicUrl,
          algorithms: auth.algorithms,
          requiredClaims: ['sub', 'exp', 'iat'],
          clockTolerance: 5,
        });
        if (
          payload.typ !== 'Bearer' ||
          !payload.sub ||
          typeof payload.iat !== 'number' ||
          payload.iat > Date.now() / 1000 + 5
        ) {
          throw new Error('Access token required');
        }
        const principal = principalFromClaims(payload, auth.clientId);
        if (!auth.requiredScopes.every((scope) => principal.scopes.has(scope))) {
          res
            .set(
              'WWW-Authenticate',
              `${challenge}, error="insufficient_scope", scope="${auth.requiredScopes.join(' ')}"`,
            )
            .status(403)
            .json({ error: 'insufficient_scope' });
          return;
        }
        res.locals.principal = principal;
        next();
      } catch {
        res
          .set('WWW-Authenticate', `${challenge}, error="invalid_token"`)
          .status(401)
          .json({ error: 'invalid_token' });
      }
    },
  };
}
