/**
 * Shared helpers for the SQLite viability load scripts (scripts/load/*.ts).
 *
 * - fixture(): builds a fresh Quorum database through the REAL services (as tests/support/harness.ts
 *   and src/seed.ts do): staff, ORCID-verified reviewers, applicants, and one call per ramp step.
 * - startServer()/stopServer(): runs `node src/server.ts` as a child process on its own port with
 *   QUORUM_DATA_DIR set to a fresh temp directory. On Windows every stop is a hard TerminateProcess.
 * - stats helpers (percentiles) and read-only database probes (delivery lag, sizes).
 *
 * Nothing here writes to src/. No npm dependencies beyond the app's own (better-sqlite3 for read-only probes).
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, openSync, closeSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

export const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const PASSWORD = 'load-test-password-2026';

export type Account = { id: string; email: string };
export type Fixture = {
  dataDir: string;
  dbFile: string;
  password: string;
  officers: Account[];
  chairs: Account[];
  reviewers: Account[];
  applicants: Account[];
  calls: string[];
};

export function freshDataDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `quorum-load-${tag}-`));
}

/** ISO 7064 MOD 11-2 valid ORCID iD derived from n (same scheme as tests/support/harness.ts). */
export function orcidFor(n: number): string {
  const base = `0000000${String(1000_0000 + n).slice(-8)}`.slice(-15);
  let total = 0;
  for (let i = 0; i < 15; i++) total = (total + Number(base[i])) * 2;
  const r = (12 - (total % 11)) % 11;
  const d = base + (r === 10 ? 'X' : String(r));
  return `${d.slice(0, 4)}-${d.slice(4, 8)}-${d.slice(8, 12)}-${d.slice(12)}`;
}

export const ABSTRACT =
  'Thawing permafrost is destabilising roads, water lines and building foundations across northern communities, yet residents learn of ground ' +
  'failure only after damage occurs. We propose a community-operated early-warning network that combines low-cost ground temperature sensors, ' +
  'satellite deformation data and local knowledge of land change. Over three years we will co-design the network with four hamlets, validate a ' +
  'thaw-risk model against field observations, and hand over dashboards and maintenance training so that infrastructure decisions are made months, ' +
  'not days, ahead of failure. The project directly strengthens climate resilience in northern communities and publishes open data and a playbook.';

/**
 * Build the load fixture in a fresh data dir, through the real services in one process (the server is
 * not running yet). Password hashing (scrypt, ~28 ms each) is done once and the hash is shared, so a
 * fixture of thousands of accounts takes seconds; sign-in still runs the full scrypt verify per request.
 */
export async function fixture(dataDir: string, o: { applicants: number; reviewers: number; officers: number; chairs: number; calls: number; envelope?: number }): Promise<Fixture> {
  const { createDeps } = await import('../../src/app.ts');
  const { systemClock } = await import('../../src/platform/clock.ts');
  const { provisionAccount, recordOrcidVerification } = await import('../../src/contexts/identity/service.ts');
  const { publishCall } = await import('../../src/contexts/calls/service.ts');
  const { hashPassword } = await import('../../src/platform/auth.ts');
  const { AGENT_ACTOR } = await import('../../src/platform/deps.ts');
  const dbFile = join(dataDir, 'quorum.sqlite');
  const deps = createDeps({ dbFile, dataDir, clock: systemClock, demo: false });
  const tx = <T>(fn: () => T): T => deps.db.transaction(fn).immediate();
  const hash = hashPassword(PASSWORD);
  const setHash = deps.db.prepare(`UPDATE idn_account SET password_hash = ? WHERE id = ?`);
  const make = (prefix: string, n: number, roles: Array<'applicant' | 'reviewer' | 'programOfficer' | 'panelChair'>) =>
    tx(() =>
      Array.from({ length: n }, (_, i) => {
        const email = `${prefix}${i}@load.quorum.test`;
        const id = provisionAccount(deps, { email, name: `${prefix} ${i}`, institution: `Institution ${i % 97}`, roles });
        setHash.run(hash, id);
        return { id, email };
      }),
    );
  tx(() => provisionAccount(deps, { id: AGENT_ACTOR, kind: 'agent', email: 'triage@agents.load.test', name: 'Eligibility triage agent', institution: 'Quorum', roles: [] }));
  const officers = make('officer', o.officers, ['programOfficer']);
  const chairs = make('chair', o.chairs, ['panelChair']);
  const reviewers = make('reviewer', o.reviewers, ['reviewer']);
  reviewers.forEach((r, i) => tx(() => recordOrcidVerification(deps, r.id, orcidFor(10_000 + i), true)));
  const applicants = make('applicant', o.applicants, ['applicant']);
  const deadline = new Date(Date.now() + 30 * 24 * 3600_000).toISOString();
  const calls: string[] = [];
  for (let c = 0; c < o.calls; c++) {
    const call = tx(() =>
      publishCall(deps, officers[0]!.id, {
        title: `Load call ${c + 1}: Climate resilience`,
        summary: 'Research that helps northern and remote communities anticipate and withstand climate-driven hazards such as permafrost thaw.',
        deadline,
        envelope: o.envelope ?? 10_000_000,
        maxRequest: 200_000,
        criteria: ['Scientific excellence', 'Community partnership', 'Feasibility and team', 'Resilience impact'].map((name) => ({ name, guidance: `Guidance for ${name}` })),
      }),
    );
    calls.push(call.id);
  }
  deps.bus.drain(); // CallPublished reaches review criteria, the budget ledger and the portfolio before the server starts
  deps.db.close();
  const f: Fixture = { dataDir, dbFile, password: PASSWORD, officers, chairs, reviewers, applicants, calls };
  writeFileSync(join(dataDir, 'load-fixture.json'), JSON.stringify(f));
  return f;
}

// ------------------------------------------------------------------------------------- server process

export type Server = { child: ChildProcess; port: number; base: string; dataDir: string; logFile: string; pid: number; exit: { code: number | null; signal: string | null; at: string } | null; stopping?: boolean };

export async function startServer(port: number, dataDir: string, logName = 'server.log', envOverrides: Record<string, string> = {}): Promise<Server> {
  const logFile = join(dataDir, logName);
  const fd = openSync(logFile, 'a');
  const child = spawn(process.execPath, ['src/server.ts'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', QUORUM_DATA_DIR: dataDir, QUORUM_DEMO: '0', LOG_LEVEL: 'error', NODE_ENV: 'development', QUORUM_RATE_LIMIT: '0', ...envOverrides },
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  closeSync(fd);
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited during startup (code ${child.exitCode}); see ${logFile}`);
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() - t0 > 30_000) {
      child.kill('SIGKILL');
      throw new Error(`server did not become healthy in 30 s; see ${logFile}`);
    }
    await sleep(100);
  }
  const srv: Server = { child, port, base, dataDir, logFile, pid: child.pid!, exit: null };
  child.once('exit', (code, signal) => {
    srv.exit = { code, signal, at: new Date().toISOString() };
    if (!srv.stopping) console.error(`[load] SERVER PID ${child.pid} EXITED UNEXPECTEDLY code=${code} signal=${signal}; see ${logFile}`);
  });
  return srv;
}

/** Hard-stop the server process (and only it). On Windows Node maps every signal to TerminateProcess. */
export async function stopServer(s: Server): Promise<void> {
  if (s.child.exitCode !== null || s.child.signalCode !== null) return;
  s.stopping = true;
  const exited = new Promise((r) => s.child.once('exit', r));
  s.child.kill('SIGKILL');
  await Promise.race([exited, sleep(5000)]);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------- HTTP (main-thread use)

export async function signIn(base: string, email: string, password = PASSWORD): Promise<string> {
  const r = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (r.status !== 200) throw new Error(`sign-in failed for ${email}: ${r.status} ${await r.text()}`);
  return ((await r.json()) as { token: string }).token;
}

export async function getJson<T = any>(base: string, path: string, token: string): Promise<T> {
  const r = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (r.status !== 200) throw new Error(`GET ${path}: ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

// ------------------------------------------------------------------------------------- statistics

export function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

export const r1 = (x: number) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : x);

// ------------------------------------------------------------------------------------- read-only DB probes

export function openRo(dbFile: string): Database.Database {
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  return db;
}

export function pendingDeliveries(dbFile: string): { pending: number; failed: number } {
  const db = openRo(dbFile);
  try {
    const r = db.prepare(`SELECT SUM(status='pending') AS pending, SUM(status='failed') AS failed FROM evt_delivery`).get() as { pending: number | null; failed: number | null };
    return { pending: r.pending ?? 0, failed: r.failed ?? 0 };
  } finally {
    db.close();
  }
}

/** Wait until no delivery is pending (or timeout). Returns the ms it took. */
export async function waitQuiescent(dbFile: string, timeoutMs = 120_000): Promise<{ ms: number; pending: number; failed: number }> {
  const t0 = Date.now();
  for (;;) {
    const p = pendingDeliveries(dbFile);
    if (p.pending === 0 || Date.now() - t0 > timeoutMs) return { ms: Date.now() - t0, ...p };
    await sleep(200);
  }
}

/**
 * Event-delivery lag, from evt_outbox.occurred_at (stamped inside the committing transaction) to the
 * LAST evt_delivery.delivered_at among that event's consumers ("delivered to every consumer").
 */
export function deliveryLag(dbFile: string, fromIso: string, toIso: string, type: string | null = 'ProposalSubmitted') {
  const db = openRo(dbFile);
  try {
    const rows = db
      .prepare(
        `SELECT o.message_id, o.occurred_at, MAX(d.delivered_at) AS last, COUNT(*) AS consumers, SUM(d.status <> 'delivered') AS undelivered
           FROM evt_outbox o JOIN evt_delivery d ON d.message_id = o.message_id
          WHERE o.occurred_at >= ? AND o.occurred_at <= ? ${type ? 'AND o.type = ?' : ''}
          GROUP BY o.message_id`,
      )
      .all(...(type ? [fromIso, toIso, type] : [fromIso, toIso])) as Array<{ occurred_at: string; last: string | null; consumers: number; undelivered: number }>;
    const lags = rows.filter((r) => r.undelivered === 0 && r.last).map((r) => Date.parse(r.last!) - Date.parse(r.occurred_at)).sort((a, b) => a - b);
    return {
      events: rows.length,
      undelivered: rows.filter((r) => r.undelivered > 0).length,
      consumersPerEvent: rows[0]?.consumers ?? 0,
      p50: pct(lags, 50),
      p95: pct(lags, 95),
      p99: pct(lags, 99),
      max: lags.at(-1) ?? NaN,
    };
  } finally {
    db.close();
  }
}

export function dbBytes(dbFile: string): { main: number; wal: number } {
  const wal = `${dbFile}-wal`;
  return { main: statSync(dbFile).size, wal: existsSync(wal) ? statSync(wal).size : 0 };
}

export function readFixture(dataDir: string): Fixture {
  return JSON.parse(readFileSync(join(dataDir, 'load-fixture.json'), 'utf8')) as Fixture;
}

/** Count server-log lines that indicate trouble (SQLITE_BUSY, unhandled 5xx, dispatcher failures). */
export function scanServerLog(logFile: string): { sqliteBusy: number; unhandled: number; dispatcherFailures: number; samples: string[] } {
  if (!existsSync(logFile)) return { sqliteBusy: 0, unhandled: 0, dispatcherFailures: 0, samples: [] };
  const lines = readFileSync(logFile, 'utf8').split(/\r?\n/);
  const busy = lines.filter((l) => /SQLITE_BUSY|database is locked/i.test(l));
  const unhandled = lines.filter((l) => l.includes('unhandled error'));
  const disp = lines.filter((l) => l.includes('[dispatcher]'));
  return { sqliteBusy: busy.length, unhandled: unhandled.length, dispatcherFailures: disp.length, samples: [...busy, ...unhandled, ...disp].slice(0, 5).map((l) => l.slice(0, 400)) };
}

/** Which source state a measurement used: HEAD, dirty files under src/, stash list, and the time. */
export function gitState(): { at: string; head: string; dirtySrc: string[]; stash: string[] } {
  const run = (args: string[]) => {
    try {
      return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  };
  return {
    at: new Date().toISOString(),
    head: run(['rev-parse', '--short', 'HEAD']),
    dirtySrc: run(['status', '--short', '--', 'src']).split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
    stash: run(['stash', 'list']).split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
  };
}

/** Mint session tokens with the server's own secret (as tests/support/harness.ts mintToken does): no scrypt. */
export async function mintTokens(dataDir: string, accounts: Account[]): Promise<Array<Account & { token: string }>> {
  const { TokenService, loadSecret } = await import('../../src/platform/auth.ts');
  const { systemClock } = await import('../../src/platform/clock.ts');
  const ts = new TokenService(loadSecret(dataDir), systemClock);
  return Promise.all(accounts.map(async (a) => ({ ...a, token: (await ts.issue(a.id)).token })));
}

/** CPU time (ms) the given process has used so far (Windows: Get-Process; elsewhere /proc or ps). */
export function processCpuMs(pid: number): number {
  try {
    if (process.platform === 'win32') {
      const outp = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).TotalProcessorTime.TotalMilliseconds`], { encoding: 'utf8' });
      return Number(outp.trim().replace(',', '.'));
    }
    const outp = execFileSync('ps', ['-o', 'cputimes=', '-p', String(pid)], { encoding: 'utf8' });
    return Number(outp.trim()) * 1000;
  } catch {
    return NaN;
  }
}
