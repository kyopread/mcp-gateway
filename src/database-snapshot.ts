import { backup, DatabaseSync } from 'node:sqlite';
import { chmod, link, lstat, mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

function verify(db: DatabaseSync) {
  const integrity = db.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
    throw new Error('Database integrity check failed');
  }
  if (db.prepare('PRAGMA user_version').get()?.user_version !== 1) {
    throw new Error('Unsupported Gateway database schema version');
  }
  for (const table of ['servers', 'users', 'groups', 'members', 'grants', 'audit']) {
    if (!db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name=?").get(table)) {
      throw new Error('Gateway database table is missing');
    }
  }
  if (db.prepare('PRAGMA foreign_key_check').all().length) {
    throw new Error('Database foreign key check failed');
  }
  if (
    db
      .prepare(
        `SELECT 1 FROM grants WHERE
    (kind='user' AND subject_id NOT IN (SELECT id FROM users)) OR
    (kind='group' AND subject_id NOT IN (SELECT id FROM groups)) LIMIT 1`,
      )
      .get()
  ) {
    throw new Error('Database contains an orphaned permission');
  }
}

async function requireAbsent(path: string) {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Destination or SQLite sidecar already exists; choose a new destination');
}

/** Consistent WAL-aware snapshot. Publish exclusively, never overwrite a live database. */
export async function snapshotDatabase(sourcePath: string, destinationPath: string) {
  const source = resolve(sourcePath);
  const destination = resolve(destinationPath);
  if (!(await lstat(source)).isFile()) throw new Error('Source must be a regular database file');
  for (const suffix of ['', '-wal', '-shm', '-journal']) await requireAbsent(destination + suffix);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(dirname(destination), '.gateway-snapshot-'));
  await chmod(staging, 0o700);
  const temporary = join(staging, 'snapshot.sqlite');
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(source, { readOnly: true });
    const pages = await backup(db, temporary);
    const snapshot = new DatabaseSync(temporary, { readOnly: true });
    try {
      verify(snapshot);
    } finally {
      snapshot.close();
    }
    await chmod(temporary, 0o600);
    const handle = await open(temporary, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporary, destination);
    return { destination, pages };
  } finally {
    db?.close();
    await rm(staging, { recursive: true, force: true });
  }
}
