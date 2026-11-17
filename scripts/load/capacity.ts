/**
 * Capacity projection: bytes per proposal lifecycle, a synthetic 10-year database, backup timing, and
 * the latency of history-sized reads and writes on that database.
 *
 *   node scripts/load/capacity.ts [--years 10] [--per-year 3000] [--port 3903] [--out docs/evidence/results/capacity.json]
 *
 * 1. Measure: a fresh fixture; N full lifecycles through the HTTP API (rush -> screen/assign/3 reviews
 *    -> decision); stop; checkpoint; size delta / N (plus a dbstat per-table breakdown).
 * 2. Synthesize: copy the measured lifecycles' rows (every table except accounts) k times with
 *    consistently suffixed ids, so each copy is a separate call with its own proposals, events,
 *    deliveries, audit and command log, until the database holds years x per-year lifecycles.
 * 3. Back up the synthetic database with better-sqlite3 db.backup() (idle, and while the server takes
 *    a write burst from another connection) and with VACUUM INTO, and time each.
 * 4. Start the server on the synthetic database and time the history-sized reads (portfolio, case
 *    list, officer workspace) and a write burst.
 */
import { copyFileSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { fixture, freshDataDir, startServer, stopServer, signIn, getJson, waitQuiescent, gitState, mintTokens, pct, r1, sleep, ROOT, PASSWORD } from './lib.ts';
import { runStep, type Tok } from './driver.ts';

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : def;
};
const years = Number(arg('years', '10'));
const perYear = Number(arg('per-year', '3000'));
const port = Number(arg('port', '3903'));
const out = resolve(ROOT, arg('out', 'docs/evidence/results/capacity.json'));
const log = (...a: unknown[]) => console.log(`[capacity ${new Date().toISOString().slice(11, 19)}]`, ...a);
const MB = 1024 * 1024;

function checkpointAndSize(file: string) {
  const db = new Database(file);
  db.pragma('wal_checkpoint(TRUNCATE)');
  const pageSize = db.pragma('page_size', { simple: true }) as number;
  const pages = db.pragma('page_count', { simple: true }) as number;
  const free = db.pragma('freelist_count', { simple: true }) as number;
  let tables: Array<{ name: string; bytes: number }> = [];
  try {
    tables = db.prepare(`SELECT name, SUM(pgsize) bytes FROM dbstat GROUP BY name ORDER BY bytes DESC`).all() as any;
  } catch {
    /* dbstat not compiled in */
  }
  db.close();
  return { bytes: pageSize * (pages - free), fileBytes: statSync(file).size, pageSize, pages, free, tables };
}

async function lifecycleBatch(base: string, f: Awaited<ReturnType<typeof fixture>>, staff: { officers: Tok[]; chairs: Tok[]; reviewers: Tok[] }, lifecycles: number) {
  const common = { base, password: PASSWORD, callId: f.calls[0]!, applicants: await mintTokens(f.dataDir, f.applicants), ...staff, readers: false };
  const rush = await runStep({ ...common, scenario: 'rush', vus: 10, durationMs: 300_000, maxLifecycles: lifecycles });
  await waitQuiescent(f.dbFile);
  const screening = (await getJson<any[]>(base, `/api/proposals?status=screening`, staff.officers[0]!.token)).map((p) => p.id);
  const review = await runStep({ ...common, scenario: 'review', vus: 10, durationMs: 600_000, items: screening });
  await waitQuiescent(f.dbFile);
  const cases = (await getJson<any[]>(base, `/api/adjudications?open=1`, staff.chairs[0]!.token)).map((c) => c.proposalId);
  const decision = await runStep({ ...common, scenario: 'decision', vus: 10, durationMs: 600_000, items: cases });
  await waitQuiescent(f.dbFile);
  return { submitted: rush.counters.lifecycles, reviewed: review.counters.lifecycles, decided: decision.counters.lifecycles, errors: rush.errorCount + review.errorCount + decision.errorCount };
}

const ACCOUNT_COLS = new Set(['applicant_id', 'reviewer_id', 'actor_id', 'decided_by', 'assigned_by', 'declared_by', 'granted_by', 'account_id', 'recipient', 'officer_id', 'chair_id']);
/** Copy every non-identity table's rows from `src` k times into `dst`, with consistently suffixed ids. */
function synthesize(dstFile: string, srcFile: string, copies: number) {
  const db = new Database(dstFile);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = OFF');
  db.pragma('foreign_keys = OFF');
  db.exec(`ATTACH DATABASE '${srcFile.replace(/'/g, "''")}' AS src`);
  const tables = (db.prepare(`SELECT name FROM src.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'idn_%'`).all() as Array<{ name: string }>).map((t) => t.name);
  const plan = tables.map((t) => {
    const cols = db.prepare(`PRAGMA src.table_info(${t})`).all() as Array<{ name: string; type: string }>;
    // columns in any UNIQUE index (besides the id rules) must also differ per copy
    const unique = new Set<string>();
    for (const ix of db.prepare(`PRAGMA src.index_list(${t})`).all() as Array<{ name: string; unique: number }>) {
      if (!ix.unique) continue;
      const ic = db.prepare(`PRAGMA src.index_info(${ix.name})`).all() as Array<{ name: string }>;
      if (ic.every((c) => ACCOUNT_COLS.has(c.name))) continue;
      for (const c of ic) if (!ACCOUNT_COLS.has(c.name)) unique.add(c.name);
    }
    const exprs = cols.map((c) => {
      const n = c.name;
      const text = !/INT|REAL/i.test(c.type);
      if (text && !ACCOUNT_COLS.has(n) && (n === 'id' || n.endsWith('_id') || n === 'partition_key' || n === 'idempotency_key' || unique.has(n))) return `CASE WHEN ${n} IS NULL THEN NULL ELSE ${n} || '~' || :k END`;
      if (!text && (n === 'seq' || n === 'last_seq' || n === 'number' || unique.has(n))) return `${n} + :k * 10000000`;
      return n;
    });
    return { t, sql: `INSERT INTO main.${t} (${cols.map((c) => c.name).join(',')}) SELECT ${exprs.join(',')} FROM src.${t}` };
  });
  // triggers (e.g. append-only or INV-5 guards) are bypassed for bulk copies: drop temporarily, recreate after
  const triggers = db.prepare(`SELECT name, sql FROM main.sqlite_master WHERE type='trigger'`).all() as Array<{ name: string; sql: string }>;
  for (const tr of triggers) db.exec(`DROP TRIGGER ${tr.name}`);
  const stmts = plan.map((p) => ({ t: p.t, s: db.prepare(p.sql) }));
  const t0 = performance.now();
  for (let k = 1; k <= copies; k++) {
    db.transaction(() => {
      for (const { s } of stmts) s.run({ k });
    })();
  }
  for (const tr of triggers) db.exec(tr.sql);
  db.exec('DETACH DATABASE src');
  db.pragma('synchronous = FULL');
  db.close();
  return { seconds: r1((performance.now() - t0) / 1000), tables: tables.length };
}

async function timeBackup(src: string, dest: string, mode: 'default' | 'all-at-once') {
  if (existsSync(dest)) rmSync(dest);
  const db = new Database(src, { readonly: true });
  const t0 = performance.now();
  let steps = 0;
  await db.backup(dest, { progress: ({ totalPages, remainingPages }) => (steps++, mode === 'all-at-once' ? totalPages : 100) });
  const ms = performance.now() - t0;
  db.close();
  return { mode, seconds: r1(ms / 1000), steps, bytes: statSync(dest).size };
}

async function main() {
  const result: any = { sourceState: gitState(), config: { years, perYear } };
  // ------------------------------------------------------------------ 1. measure bytes per lifecycle
  const dataDir = freshDataDir('capacity');
  const f = await fixture(dataDir, { applicants: 600, reviewers: 300, officers: 15, chairs: 5, calls: 1, envelope: 15_000_000 });
  const before = checkpointAndSize(f.dbFile);
  let server = await startServer(port, dataDir);
  const sign = async (a: { id: string; email: string }): Promise<Tok> => ({ ...a, token: await signIn(server.base, a.email) });
  const staff = { officers: await Promise.all(f.officers.map(sign)), chairs: await Promise.all(f.chairs.map(sign)), reviewers: [] as Tok[] };
  for (const r of f.reviewers) staff.reviewers.push(await sign(r));
  log('measuring one call of lifecycles');
  const batch = await lifecycleBatch(server.base, f, staff, 500);
  await stopServer(server);
  const after = checkpointAndSize(f.dbFile);
  const N = batch.decided;
  const perLifecycle = (after.bytes - before.bytes) / N;
  const perTable = after.tables.map((t) => ({ name: t.name, bytes: t.bytes, perLifecycle: r1(t.bytes / N) }));
  result.measure = { batch, fixtureBytes: before.bytes, afterBytes: after.bytes, lifecycles: N, bytesPerLifecycle: Math.round(perLifecycle), perTable: perTable.slice(0, 20) };
  log(`bytes per lifecycle: ${Math.round(perLifecycle)} over ${N} decided lifecycles (${JSON.stringify(batch)})`);

  // ------------------------------------------------------------------ 2. synthesize the 10-year database
  const target = years * perYear;
  const copies = Math.max(1, Math.ceil(target / N) - 1);
  const synthDir = freshDataDir('capacity-10y');
  const synthDb = join(synthDir, 'quorum.sqlite');
  copyFileSync(f.dbFile, synthDb);
  copyFileSync(join(dataDir, 'jwt-secret'), join(synthDir, 'jwt-secret'));
  log(`synthesizing ${copies} copies of ${N} lifecycles -> ~${(copies + 1) * N} lifecycles`);
  const syn = synthesize(synthDb, f.dbFile, copies);
  const synthSize = checkpointAndSize(synthDb);
  const projectedBytes = perLifecycle * target + before.bytes;
  result.synthetic = { copies, lifecycles: (copies + 1) * N, buildSeconds: syn.seconds, bytes: synthSize.bytes, mb: r1(synthSize.bytes / MB), projectedMbFromPerLifecycle: r1(projectedBytes / MB), topTables: synthSize.tables.slice(0, 10).map((t) => ({ name: t.name, mb: r1(t.bytes / MB) })) };
  log('synthetic db', result.synthetic);

  // ------------------------------------------------------------------ 3. backups
  const bdir = freshDataDir('capacity-backup');
  result.backup = { idle: [] as any[] };
  result.backup.idle.push(await timeBackup(synthDb, join(bdir, 'b1.sqlite'), 'default'));
  result.backup.idle.push(await timeBackup(synthDb, join(bdir, 'b2.sqlite'), 'all-at-once'));
  {
    const db = new Database(synthDb, { readonly: true });
    const t0 = performance.now();
    db.exec(`VACUUM INTO '${join(bdir, 'b3.sqlite').replace(/'/g, "''")}'`);
    result.backup.idle.push({ mode: 'VACUUM INTO', seconds: r1((performance.now() - t0) / 1000), bytes: statSync(join(bdir, 'b3.sqlite')).size });
    db.close();
  }
  // What verifying a backup costs (src/platform/backup.ts verifyBackup: sha256 of the whole file via
  // readFileSync + PRAGMA integrity_check). Both are synchronous; run in the server process they block its event loop.
  {
    const file = join(bdir, 'b2.sqlite');
    let t0 = performance.now();
    const { createHash } = await import('node:crypto');
    const { readFileSync } = await import('node:fs');
    createHash('sha256').update(readFileSync(file)).digest('hex');
    const shaMs = performance.now() - t0;
    const vdb = new Database(file, { readonly: true });
    t0 = performance.now();
    const ic = (vdb.pragma('integrity_check') as any[])[0]?.integrity_check;
    const icMs = performance.now() - t0;
    t0 = performance.now();
    const qc = (vdb.pragma('quick_check') as any[])[0]?.quick_check;
    const qcMs = performance.now() - t0;
    vdb.close();
    result.backup.verifyCost = { sha256ReadFileSyncS: r1(shaMs / 1000), integrityCheckS: r1(icMs / 1000), integrity: ic, quickCheckS: r1(qcMs / 1000), quick: qc };
  }
  log('idle backups', result.backup.idle, result.backup.verifyCost);

  // ------------------------------------------------------------------ 4. server on the 10-year database
  server = await startServer(port, synthDir);
  const s2 = { officers: await Promise.all(f.officers.slice(0, 3).map(async (a) => ({ ...a, token: await signIn(server.base, a.email) }))), chairs: await Promise.all(f.chairs.slice(0, 2).map(async (a) => ({ ...a, token: await signIn(server.base, a.email) }))) };
  const timeGet = async (path: string, token: string, n = 15) => {
    const ms: number[] = [];
    let bytes = 0;
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      const r = await fetch(`${server.base}${path}`, { headers: { authorization: `Bearer ${token}` } });
      const b = await r.arrayBuffer();
      ms.push(performance.now() - t0);
      bytes = b.byteLength;
      if (r.status !== 200) return { path, status: r.status };
    }
    ms.sort((a, b) => a - b);
    return { path, n, p50: r1(pct(ms, 50)), p95: r1(pct(ms, 95)), max: r1(ms.at(-1)!), responseKB: r1(bytes / 1024) };
  };
  result.historyReads = [
    await timeGet('/api/portfolio', s2.chairs[0]!.token),
    await timeGet(`/api/portfolio?callId=${f.calls[0]}`, s2.chairs[0]!.token),
    await timeGet('/api/adjudications', s2.chairs[0]!.token, 5),
    await timeGet('/api/adjudications?open=1', s2.chairs[0]!.token),
    await timeGet('/api/workspace/officer', s2.officers[0]!.token),
    await timeGet('/api/activity', s2.officers[0]!.token),
  ];
  log('history-sized reads', result.historyReads);

  // query plans the history makes expensive
  {
    const db = new Database(synthDb, { readonly: true });
    const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((r) => r.detail).join(' | ');
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) db.prepare(`SELECT COUNT(*) n FROM evt_delivery WHERE partition_key = ? AND consumer LIKE 'adjudication.%' AND status <> 'delivered'`).get(`proposal:x${i}`);
    const awardGuardMs = (performance.now() - t0) / 20;
    result.queryPlans = {
      awardInFlightGuard: { plan: plan(`SELECT COUNT(*) n FROM evt_delivery WHERE partition_key = 'p' AND consumer LIKE 'adjudication.%' AND status <> 'delivered'`), msPerCall: r1(awardGuardMs), rows: (db.prepare(`SELECT COUNT(*) n FROM evt_delivery`).get() as any).n },
      portfolioByCall: plan(`SELECT * FROM ovs_proposal WHERE call_id = 'c' ORDER BY COALESCE(mean_score, -1) DESC, submitted_at`),
      listProposalsByCall: plan(`SELECT * FROM sub_proposal WHERE call_id = 'c'`),
      dueDeliveries: plan(`SELECT d.consumer, d.message_id FROM evt_delivery d WHERE d.status = 'pending' AND d.next_attempt_at <= 'z' AND NOT EXISTS (SELECT 1 FROM evt_delivery e WHERE e.consumer = d.consumer AND e.partition_key = d.partition_key AND e.seq < d.seq AND e.status NOT IN ('delivered','skipped')) ORDER BY d.seq LIMIT 200`),
    };
    db.close();
    log('query plans', result.queryPlans);
  }

  // write burst on the 10-year database, with an online backup from a second connection running alongside
  const fresh = f.applicants.slice(0, 300);
  const reviewers: Tok[] = [];
  const backupDuringLoad = (async () => {
    await sleep(2000);
    const r: any[] = [];
    for (const mode of ['default', 'all-at-once'] as const) {
      const t0 = performance.now();
      const res = await Promise.race([timeBackup(synthDb, join(bdir, `live-${mode}.sqlite`), mode), sleep(120_000).then(() => ({ mode, seconds: '>120 (gave up)' }))]);
      r.push({ ...res, startedAfterLoadStartS: 2, wallS: r1((performance.now() - t0) / 1000) });
    }
    return r;
  })();
  const burst = await runStep({ base: server.base, scenario: 'rush', vus: 50, durationMs: 30_000, password: PASSWORD, callId: f.calls[0]!, applicants: fresh, reviewers, officers: s2.officers, chairs: s2.chairs, readers: true });
  result.backup.duringWriteBurst = await backupDuringLoad;
  const { acks: _a, perLabel, ...rest } = burst;
  result.writeBurstOn10y = { ...rest, perLabel: perLabel.slice(0, 12) };
  log('write burst on 10-year db', { rps: burst.rps, cmdps: burst.cmdps, p50: burst.p50, p95: burst.p95, p99: burst.p99, errors: burst.errors });
  log('backups during write burst', result.backup.duringWriteBurst);
  await stopServer(server);

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2));
  log('wrote', out);
  for (const d of [dataDir, synthDir, bdir]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
