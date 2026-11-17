/**
 * Backup and restore (production gap closed this release).
 *
 * Backup is ONLINE: better-sqlite3's db.backup() uses SQLite's backup API, which copies a consistent
 * snapshot while the server keeps serving. Every backup is verified before it counts: the copy is
 * opened read-only, PRAGMA integrity_check must answer "ok", and its schema version must be one this
 * build knows. A sha256 sidecar records what was verified. Old backups are pruned to a retention count.
 *
 * Restore is OFFLINE: it refuses while a server holds the database (the pid file names a live process),
 * verifies the backup the same way, moves the current file aside (never deletes it), and copies the
 * backup into place. On the next start, pending deliveries resume from the restored outbox: anything
 * committed after the backup was taken is lost, which is the recovery point the backup interval sets.
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Db } from './db.ts';
import { MIGRATIONS } from './schema.ts';

export type BackupResult = { file: string; bytes: number; sha256: string; schemaVersion: number; tookMs: number };
export type VerifyResult = { ok: boolean; integrity: string; schemaVersion: number; sha256: string; problems: string[] };

const sha256File = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');

export function verifyBackup(file: string): VerifyResult {
  const problems: string[] = [];
  if (!existsSync(file)) return { ok: false, integrity: 'missing', schemaVersion: -1, sha256: '', problems: [`${file} does not exist`] };
  const sha256 = sha256File(file);
  const side = `${file}.sha256`;
  if (existsSync(side) && readFileSync(side, 'utf8').trim().split(/\s+/)[0] !== sha256) problems.push('checksum does not match the .sha256 sidecar');
  let integrity = 'unreadable';
  let schemaVersion = -1;
  try {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      integrity = String((db.pragma('integrity_check') as Array<{ integrity_check: string }>)[0]?.integrity_check);
      schemaVersion = db.pragma('user_version', { simple: true }) as number;
    } finally {
      db.close();
    }
  } catch (e) {
    problems.push(`cannot open: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (integrity !== 'ok') problems.push(`integrity_check: ${integrity}`);
  if (schemaVersion > MIGRATIONS.length) problems.push(`schema version ${schemaVersion} is newer than this build (${MIGRATIONS.length})`);
  if (schemaVersion < 1) problems.push('not a Quorum database (schema version 0)');
  return { ok: problems.length === 0, integrity, schemaVersion, sha256, problems };
}

export async function backupTo(db: Db, dir: string, now: Date = new Date(), keep = 14): Promise<BackupResult> {
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `quorum-${stamp}.sqlite`);
  const t0 = Date.now();
  await db.backup(file);
  const v = verifyBackup(file);
  if (!v.ok) {
    rmSync(file, { force: true });
    throw new Error(`backup failed verification: ${v.problems.join('; ')}`);
  }
  writeFileSync(`${file}.sha256`, `${v.sha256}  ${basename(file)}\n`);
  prune(dir, keep);
  return { file, bytes: statSync(file).size, sha256: v.sha256, schemaVersion: v.schemaVersion, tookMs: Date.now() - t0 };
}

export function listBackups(dir: string): Array<{ file: string; bytes: number; at: string }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^quorum-.*\.sqlite$/.test(f))
    .sort()
    .map((f) => {
      const st = statSync(join(dir, f));
      return { file: join(dir, f), bytes: st.size, at: st.mtime.toISOString() };
    });
}

function prune(dir: string, keep: number) {
  const all = listBackups(dir);
  for (const b of all.slice(0, Math.max(0, all.length - keep))) {
    rmSync(b.file, { force: true });
    rmSync(`${b.file}.sha256`, { force: true });
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export function pidFileFor(dbFile: string) {
  return `${dbFile}.pid`;
}

/** Restore a verified backup over dbFile. Refuses while a live server holds it. Returns where the old file went. */
export function restoreFrom(backupFile: string, dbFile: string, now: Date = new Date()): { restored: string; previous: string | null; schemaVersion: number } {
  const pidFile = pidFileFor(dbFile);
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    if (Number.isFinite(pid) && pid > 0 && alive(pid)) throw new Error(`a Quorum server (pid ${pid}) is using ${dbFile}; stop it before restoring`);
  }
  const v = verifyBackup(backupFile);
  if (!v.ok) throw new Error(`refusing to restore an unverified backup: ${v.problems.join('; ')}`);
  let previous: string | null = null;
  if (existsSync(dbFile)) {
    previous = `${dbFile}.before-restore-${now.toISOString().replace(/[:.]/g, '-')}`;
    renameSync(dbFile, previous);
    for (const ext of ['-wal', '-shm']) if (existsSync(dbFile + ext)) renameSync(dbFile + ext, previous + ext);
  }
  copyFileSync(backupFile, dbFile);
  return { restored: dbFile, previous, schemaVersion: v.schemaVersion };
}
