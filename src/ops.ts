/**
 * Operator command line — `npm run ops -- <command>`.
 *
 *   backup  [--dir <dir>] [--keep <n>]     online backup of the live database, verified (safe while serving)
 *   verify  <backup-file>                  integrity, schema version and checksum of a backup
 *   list    [--dir <dir>]                  the backups present
 *   restore <backup-file>                  OFFLINE restore: refuses while a server holds the database
 *
 * QUORUM_DATA_DIR / QUORUM_DB locate the database; QUORUM_BACKUP_DIR (default <data>/backups) the backups.
 */
import { join } from 'node:path';
import { openDb } from './platform/db.ts';
import { backupTo, listBackups, restoreFrom, verifyBackup } from './platform/backup.ts';

const dataDir = process.env.QUORUM_DATA_DIR ?? 'data';
const dbFile = process.env.QUORUM_DB ?? join(dataDir, 'quorum.sqlite');
const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string, d: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] ? rest[i + 1]! : d;
};
const dir = flag('dir', process.env.QUORUM_BACKUP_DIR ?? join(dataDir, 'backups'));

async function main() {
  switch (cmd) {
    case 'backup': {
      const db = openDb(dbFile);
      try {
        const r = await backupTo(db, dir, new Date(), Number(flag('keep', process.env.QUORUM_BACKUP_KEEP ?? '14')));
        db.prepare(`INSERT INTO ops_action (at, actor_id, action, subject, reason) VALUES (?, 'operator-cli', 'backup', ?, 'manual backup')`).run(new Date().toISOString(), r.file);
        console.log(JSON.stringify(r));
      } finally {
        db.close();
      }
      return;
    }
    case 'verify': {
      const v = verifyBackup(rest[0] ?? '');
      console.log(JSON.stringify(v));
      process.exitCode = v.ok ? 0 : 2;
      return;
    }
    case 'list':
      for (const b of listBackups(dir)) console.log(`${b.at}  ${String(b.bytes).padStart(12)}  ${b.file}`);
      return;
    case 'restore': {
      const r = restoreFrom(rest[0] ?? '', dbFile);
      // record the restore in the restored database itself, so its own audit shows where it came from
      const db = openDb(dbFile);
      try {
        db.prepare(`INSERT INTO ops_action (at, actor_id, action, subject, reason) VALUES (?, 'operator-cli', 'restore', ?, ?)`).run(
          new Date().toISOString(),
          rest[0] ?? '',
          `restored over ${dbFile}; previous file kept at ${r.previous ?? '(none)'}`,
        );
      } finally {
        db.close();
      }
      console.log(JSON.stringify(r));
      return;
    }
    default:
      console.error('usage: npm run ops -- backup|verify <file>|list|restore <file>');
      process.exitCode = 64;
  }
}

main().catch((e) => {
  console.error(`[ops] ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
});
