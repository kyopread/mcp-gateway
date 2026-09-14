import { z } from 'zod';
import { readSecret, type Config } from './config.js';
import type { UserRecord } from './store.js';

export async function fetchDirectoryUsers(config: Config): Promise<UserRecord[]> {
  if (config.auth.mode !== 'keycloak' || !config.console.directory)
    throw new Error('Keycloak directory is not configured');
  const directory = config.console.directory;
  const signal = AbortSignal.timeout(config.timeoutMs);
  const response = await fetch(`${config.auth.issuer}/protocol/openid-connect/token`, {
    method: 'POST',
    redirect: 'error',
    signal,
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: directory.clientId,
      client_secret: readSecret(directory.clientSecretEnv),
    }),
  });
  if (!response.ok) throw new Error('Directory authentication failed');
  const { access_token } = z
    .object({ access_token: z.string().min(1) })
    .parse(await response.json());
  const issuer = new URL(config.auth.issuer);
  const marker = issuer.pathname.lastIndexOf('/realms/');
  if (marker < 0) throw new Error('Invalid Keycloak realm URL');
  const adminBase = `${issuer.origin}${issuer.pathname.slice(0, marker)}/admin${issuer.pathname.slice(marker)}`;
  const users: UserRecord[] = [];
  const schema = z.array(
    z.object({
      id: z.string(),
      username: z.string(),
      email: z.string().optional(),
      enabled: z.boolean(),
    }),
  );
  for (let first = 0; first <= 10000; first += 100) {
    const page = await fetch(`${adminBase}/users?first=${first}&max=100&briefRepresentation=true`, {
      headers: { Authorization: `Bearer ${access_token}` },
      signal,
      redirect: 'error',
    });
    if (!page.ok) throw new Error('Directory query failed');
    const entries = schema.parse(await page.json());
    if (first === 10000 && entries.length) throw new Error('Directory limit exceeded');
    users.push(...entries.map((user) => ({ ...user, email: user.email ?? '' })));
    if (entries.length < 100) return users;
  }
  return users;
}
