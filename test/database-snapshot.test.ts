import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { snapshotDatabase } from '../src/database-snapshot.js';
import { serverSchema } from '../src/config.js';
import type { Principal } from '../src/auth.js';

test('live WAL backup restores users, groups, deny priority and audit independently', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-backup-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'live.sqlite');
  const store = new Store(source);
  t.after(() => store.close());
  store.saveServer({
    id: 'demo',
    name: 'Demo',
    description: '',
    enabled: true,
    source: 'console',
    upstream: serverSchema.parse({ transport: 'http', url: 'https://example.com/mcp' }),
  });
  store.upsertUser({ id: 'alice', username: 'Alice', email: '', enabled: true });
  const group = store.saveGroup({ name: 'Team', description: '', members: ['alice'] });
  store.setGrants('group', group, [{ serverId: 'demo', effect: 'allow' }]);
  store.setGrants('user', 'alice', [{ serverId: 'demo', effect: 'deny' }]);
  store.audit('admin', 'permissions.user.update', 'Alice');
  assert.ok((await stat(source + '-wal')).size > 0);
  const backupPath = join(dir, 'backup.sqlite');
  await snapshotDatabase(source, backupPath);
  store.setGrants('user', 'alice', []);
  const restoredPath = join(dir, 'restored.sqlite');
  await snapshotDatabase(backupPath, restoredPath);
  const restored = new Store(restoredPath);
  t.after(() => restored.close());
  const principal: Principal = {
    subject: 'alice',
    username: 'Alice',
    email: '',
    groups: new Set(),
    roles: new Set(),
    scopes: new Set(),
  };
  assert.equal(store.decision(principal, 'demo'), 'allow');
  assert.equal(restored.decision(principal, 'demo'), 'deny');
  assert.deepEqual(restored.groups()[0].members, ['alice']);
  assert.equal(restored.events()[0].action, 'permissions.user.update');
  assert.equal(restored.servers().length, 1);
  assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
  await assert.rejects(snapshotDatabase(source, backupPath), /already exists/);
  await assert.rejects(snapshotDatabase(source, source), /already exists/);
});

test('bad snapshots and leftover destination sidecars are rejected without publishing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-bad-backup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const unrelated = join(dir, 'other.sqlite');
  const db = new DatabaseSync(unrelated);
  db.exec('CREATE TABLE other(id INTEGER)');
  db.close();
  const target = join(dir, 'output.sqlite');
  await assert.rejects(snapshotDatabase(unrelated, target), /schema version/);
  await assert.rejects(stat(target), { code: 'ENOENT' });
  await writeFile(target + '-wal', 'existing state');
  await assert.rejects(snapshotDatabase(unrelated, target), /already exists/);
  await assert.rejects(snapshotDatabase(join(dir, 'missing.sqlite'), target), { code: 'ENOENT' });
});
