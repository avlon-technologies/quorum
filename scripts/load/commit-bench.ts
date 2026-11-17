/**
 * Micro-benchmark: cost of one small write transaction on this disk, as Quorum opens SQLite
 * (WAL, synchronous=FULL) versus synchronous=NORMAL. better-sqlite3 is synchronous, so this time is
 * spent ON the server's single event loop for every command and every event delivery.
 *
 *   node scripts/load/commit-bench.ts [--n 2000]
 */
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { freshDataDir, pct, r1 } from './lib.ts';

const n = Number(process.argv[process.argv.indexOf('--n') + 1] || 2000) || 2000;
const dir = freshDataDir('commit-bench');
const out: any[] = [];
for (const sync of ['FULL', 'NORMAL', 'OFF']) {
  const db = new Database(join(dir, `b-${sync}.sqlite`));
  db.pragma('journal_mode = WAL');
  db.pragma(`synchronous = ${sync}`);
  db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, k TEXT, v TEXT)`);
  const ins = db.prepare(`INSERT INTO t (k, v) VALUES (?, ?)`);
  const tx = db.transaction((i: number) => ins.run(`k${i}`, 'x'.repeat(400)));
  const ms: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    tx.immediate(i);
    ms.push(performance.now() - t0);
  }
  ms.sort((a, b) => a - b);
  const total = ms.reduce((a, b) => a + b, 0);
  out.push({ synchronous: sync, commits: n, perSecond: r1((n / total) * 1000), p50: r1(pct(ms, 50) * 1000) / 1000, p95: r1(pct(ms, 95) * 1000) / 1000, p99: r1(pct(ms, 99) * 1000) / 1000 });
  db.close();
}
console.log(JSON.stringify(out, null, 2));
try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* ignore */
}
