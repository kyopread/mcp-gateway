import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Principal } from './auth.js';
import type { Upstream } from './config.js';

export type ServerRecord = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  source: 'file' | 'console';
  upstream: Upstream;
};
export type UserRecord = { id: string; username: string; email: string; enabled: boolean };
export type GroupRecord = { id: string; name: string; description: string; members: string[] };
export type Grant = {
  kind: 'user' | 'group';
  subjectId: string;
  serverId: string;
  effect: 'allow' | 'deny';
};

export class Store {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS servers (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL, email TEXT NOT NULL, enabled INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members (group_id TEXT REFERENCES groups(id) ON DELETE CASCADE, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY(group_id,user_id));
      CREATE TABLE IF NOT EXISTS grants (kind TEXT NOT NULL CHECK(kind IN ('user','group')), subject_id TEXT NOT NULL, server_id TEXT REFERENCES servers(id) ON DELETE CASCADE, effect TEXT NOT NULL CHECK(effect IN ('allow','deny')), PRIMARY KEY(kind,subject_id,server_id));
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, outcome TEXT NOT NULL);
      PRAGMA user_version=1;`);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  servers(): ServerRecord[] {
    return this.db
      .prepare('SELECT data FROM servers ORDER BY id')
      .all()
      .map((row) => JSON.parse(row.data as string));
  }
  saveServer(server: ServerRecord) {
    this.db
      .prepare(
        'INSERT INTO servers(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(server.id, JSON.stringify(server));
  }
  deleteServer(id: string) {
    this.db.prepare('DELETE FROM servers WHERE id=?').run(id);
  }
  upsertUser(user: UserRecord) {
    this.db
      .prepare(
        'INSERT INTO users VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username,email=excluded.email,enabled=excluded.enabled',
      )
      .run(user.id, user.username, user.email, Number(user.enabled));
  }
  users(): UserRecord[] {
    return this.db
      .prepare('SELECT * FROM users ORDER BY username')
      .all()
      .map((row) => ({
        id: row.id as string,
        username: row.username as string,
        email: row.email as string,
        enabled: !!row.enabled,
      }));
  }
  groups(): GroupRecord[] {
    return this.db
      .prepare('SELECT * FROM groups ORDER BY name')
      .all()
      .map((row) => ({
        id: row.id as string,
        name: row.name as string,
        description: row.description as string,
        members: this.db
          .prepare('SELECT user_id FROM members WHERE group_id=?')
          .all(row.id as string)
          .map((member) => member.user_id as string),
      }));
  }
  saveGroup(group: Omit<GroupRecord, 'id'> & { id?: string }): string {
    const id = group.id ?? randomUUID();
    this.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO groups VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description',
        )
        .run(id, group.name, group.description);
      this.db.prepare('DELETE FROM members WHERE group_id=?').run(id);
      for (const userId of new Set(group.members))
        this.db.prepare('INSERT INTO members VALUES (?,?)').run(id, userId);
    });
    return id;
  }
  deleteGroup(id: string) {
    this.transaction(() => {
      this.db.prepare("DELETE FROM grants WHERE kind='group' AND subject_id=?").run(id);
      this.db.prepare('DELETE FROM groups WHERE id=?').run(id);
    });
  }
  grants(): Grant[] {
    return this.db
      .prepare('SELECT * FROM grants')
      .all()
      .map((row) => ({
        kind: row.kind as Grant['kind'],
        subjectId: row.subject_id as string,
        serverId: row.server_id as string,
        effect: row.effect as Grant['effect'],
      }));
  }
  setGrants(kind: Grant['kind'], subjectId: string, grants: Pick<Grant, 'serverId' | 'effect'>[]) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM grants WHERE kind=? AND subject_id=?').run(kind, subjectId);
      for (const grant of grants)
        this.db
          .prepare('INSERT INTO grants VALUES (?,?,?,?)')
          .run(kind, subjectId, grant.serverId, grant.effect);
    });
  }
  decision(principal: Principal, serverId: string): 'allow' | 'deny' | undefined {
    const rows = this.db
      .prepare(
        `SELECT effect FROM grants WHERE server_id=? AND
      ((kind='user' AND subject_id=?) OR (kind='group' AND subject_id IN (SELECT group_id FROM members WHERE user_id=?)))`,
      )
      .all(serverId, principal.subject, principal.subject);
    if (rows.some((row) => row.effect === 'deny')) return 'deny';
    if (rows.some((row) => row.effect === 'allow')) return 'allow';
    return undefined;
  }
  audit(actor: string, action: string, target: string, outcome = 'success') {
    this.db
      .prepare('INSERT INTO audit(at,actor,action,target,outcome) VALUES (?,?,?,?,?)')
      .run(new Date().toISOString(), actor, action, target, outcome);
    // Bound the embedded log. Export application logs for long-term audit retention.
    this.db.prepare('DELETE FROM audit WHERE id <= (SELECT MAX(id)-10000 FROM audit)').run();
  }
  events() {
    return this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 200').all();
  }
  close() {
    this.db.close();
  }
}
