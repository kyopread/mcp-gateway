import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';

// Use a disposable Keycloak distribution: this command imports a test realm.
if (!process.env.KEYCLOAK_HOME)
  throw new Error('Set KEYCLOAK_HOME to a disposable Keycloak 26.7.3 distribution');
const home = resolve(process.env.KEYCLOAK_HOME);
const temporary = await mkdtemp(join(tmpdir(), 'gateway-real-idp-'));
const children = [];
const env = {
  ...process.env,
  GATEWAY_SMOKE_CLIENT_SECRET: randomBytes(32).toString('hex'),
  KEYCLOAK_DIRECTORY_SECRET: randomBytes(32).toString('hex'),
  KEYCLOAK_CONSOLE_PASSWORD: randomBytes(32).toString('hex'),
  KEYCLOAK_ISSUER: 'http://127.0.0.1:8180/realms/mcp-gateway',
  MCP_GATEWAY_URL: 'http://127.0.0.1:3200/mcp',
};
function start(command, args, overrides = {}) {
  const child = spawn(command, args, {
    env: { ...env, ...overrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.on('error', (error) => {
    child.startError = error;
  });
  // Do not echo identity-provider output or tokens. Retain exit status for diagnosis.
  child.stdout.resume();
  child.stderr.resume();
  children.push(child);
  return child;
}
async function ready(url, child) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.startError) throw child.startError;
    if (child.exitCode !== null)
      throw new Error(`Process exited with ${child.exitCode} before ${url} was ready`);
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Readiness timeout: ${url}`);
}
try {
  for (const port of [8180, 3200]) {
    await new Promise((resolve, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', () => probe.close(resolve));
    });
  }
  const realm = (await readFile('deploy/keycloak/mcp-gateway-realm.json', 'utf8')).replaceAll(
    '127.0.0.1:3000',
    '127.0.0.1:3200',
  );
  await mkdir(join(home, 'data/import'), { recursive: true });
  await writeFile(join(home, 'data/import/mcp-gateway-realm.json'), realm, {
    flag: 'wx',
    mode: 0o600,
  });
  const keycloak = start(join(home, 'bin/kc.sh'), [
    'start-dev',
    '--http-host=127.0.0.1',
    '--http-port=8180',
    '--import-realm',
  ]);
  await ready(`${env.KEYCLOAK_ISSUER}/.well-known/openid-configuration`, keycloak);
  const config = JSON.parse(await readFile('config/local.json', 'utf8'));
  config.port = 3200;
  config.publicUrl = env.MCP_GATEWAY_URL;
  config.auth.issuer = env.KEYCLOAK_ISSUER;
  config.console.databasePath = join(temporary, 'gateway.sqlite');
  const configPath = join(temporary, 'gateway.json');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const gateway = start(process.execPath, ['dist/index.js'], { MCP_GATEWAY_CONFIG: configPath });
  await ready('http://127.0.0.1:3200/ready', gateway);
  const smoke = start(process.execPath, ['examples/keycloak-smoke.mjs'], {
    MCP_GATEWAY_CONFIG: configPath,
  });
  await new Promise((resolve, reject) => {
    smoke.on('error', reject);
    smoke.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`Keycloak smoke failed (${code})`)),
    );
  });
  const tokenResponse = await fetch(`${env.KEYCLOAK_ISSUER}/protocol/openid-connect/token`, {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'gateway-directory',
      client_secret: env.KEYCLOAK_DIRECTORY_SECRET,
    }),
  });
  if (!tokenResponse.ok) throw new Error(`Directory token failed (${tokenResponse.status})`);
  const { access_token } = await tokenResponse.json();
  const users = await fetch('http://127.0.0.1:8180/admin/realms/mcp-gateway/users?max=100', {
    signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!users.ok || !(await users.json()).some((user) => user.username === 'console-admin'))
    throw new Error('Directory cannot read console-admin');
  console.log(
    'PASS: real Keycloak JWT, reader filtering, tool allow/deny, directory service account',
  );
} finally {
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.startError) return resolve();
          const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
          child.kill('SIGTERM');
        }),
    ),
  );
  await rm(temporary, { recursive: true, force: true });
}
