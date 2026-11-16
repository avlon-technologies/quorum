import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './schema.ts';

export type Db = Database.Database;

/**
 * Opens the single SQLite file (NFR-1, NFR-4).
 * WAL + synchronous=FULL: every committed transaction survives a process crash and power loss.
 * busy_timeout lets a second process (or a second connection in tests) wait for the write lock
 * instead of failing, which is what makes the INV-9 conditional write safe across connections.
 */
export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

/** Forward-only, numbered migrations tracked in PRAGMA user_version. Startup fails loudly on a newer schema. */
export function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > MIGRATIONS.length) {
    throw new Error(
      `Database schema version ${current} is newer than this build supports (${MIGRATIONS.length}). ` +
        `Run a newer Quorum build, or start with a fresh data file (npm run seed).`,
    );
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    const sql = MIGRATIONS[v]!;
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${v + 1}`);
    }).immediate();
  }
}

/** Run fn in a write transaction that takes the write lock up front (BEGIN IMMEDIATE). */
export function inTx<T>(db: Db, fn: () => T): T {
  return db.transaction(fn).immediate();
}
