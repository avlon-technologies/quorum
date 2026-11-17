/**
 * Ramp test: deadline rush -> review period -> decision day, at increasing concurrency.
 *
 *   node scripts/load/ramp.ts [--levels 10,50,100,200] [--extend] [--duration 20] [--port 3901] [--out docs/evidence/results/ramp.json]
 *
 * For each level L: a fresh call receives a deadline rush of L virtual users for --duration seconds;
 * then L VUs screen/assign/review everything waiting in screening; then L VUs decide every open case.
 * After each step the script waits for the outbox to drain and measures event-delivery lag from
 * evt_outbox/evt_delivery (database opened read-only). --extend keeps doubling the level past the
 * last one until p95 > 500 ms or an error appears (max 1600).
 */
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fixture, freshDataDir, startServer, stopServer, signIn, getJson, waitQuiescent, deliveryLag, dbBytes, scanServerLog, gitState, mintTokens, processCpuMs, pct, r1, ROOT, PASSWORD } from './lib.ts';
import { runStep, type StepResult, type Tok } from './driver.ts';

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : def;
};
const levels = arg('levels', '10,50,100,200').split(',').map(Number);
const extend = process.argv.includes('--extend');
const durationMs = Number(arg('duration', '20')) * 1000;
const port = Number(arg('port', '3901'));
const out = resolve(ROOT, arg('out', 'docs/evidence/results/ramp.json'));
const keep = process.argv.includes('--keep');
const mint = process.argv.includes('--mint');
const perCall = Number(arg('per-call', '500'));
const readers = !process.argv.includes('--no-readers');
const scenarios = arg('scenarios', 'rush,review,decision').split(',');
const workMaxMs = Number(arg('work-max', '180')) * 1000;
const MAX_LEVELS = 8;
const PER_LEVEL_APPLICANTS = 1500;

const log = (...a: unknown[]) => console.log(`[ramp ${new Date().toISOString().slice(11, 19)}]`, ...a);

async function main() {
  const dataDir = freshDataDir('ramp');
  log('data dir', dataDir);
  let t = performance.now();
  const f = await fixture(dataDir, { applicants: PER_LEVEL_APPLICANTS * MAX_LEVELS, reviewers: 300, officers: 15, chairs: 5, calls: MAX_LEVELS, envelope: 10_000_000 });
  log(`fixture: ${f.applicants.length} applicants, ${f.reviewers.length} reviewers, ${f.officers.length} officers, ${f.chairs.length} chairs, ${f.calls.length} calls in ${r1((performance.now() - t) / 1000)} s`);
  const server = await startServer(port, dataDir);
  log(`server pid ${server.pid} on ${server.base}`);
  const result: any = { sourceState: gitState(), config: { levels, extend, durationMs, rateLimit: 'QUORUM_RATE_LIMIT=0', perCall, workMaxMs, scenarios, staffReaders: readers ? '20% of VUs, one history page per second each' : 'none', applicantTokens: mint ? 'minted (no sign-in in the rush)' : 'sign-in per applicant in the rush' }, signInWarmup: null, levels: [], dataDir };
  try {
    // Staff and reviewers sign in once; their tokens are reused for the whole run (8 h expiry).
    t = performance.now();
    const signLat: number[] = [];
    const sign = async (a: { id: string; email: string }): Promise<Tok> => {
      const s = performance.now();
      const token = await signIn(server.base, a.email, PASSWORD);
      signLat.push(performance.now() - s);
      return { ...a, token };
    };
    const pool = async <T, R>(xs: T[], n: number, fn: (x: T) => Promise<R>) => {
      const res: R[] = new Array(xs.length);
      let i = 0;
      await Promise.all(Array.from({ length: n }, async () => {
        while (i < xs.length) {
          const k = i++;
          res[k] = await fn(xs[k]!);
        }
      }));
      return res;
    };
    const officers = await pool(f.officers, 10, sign);
    const chairs = await pool(f.chairs, 10, sign);
    const reviewers = await pool(f.reviewers, 10, sign);
    const wall = (performance.now() - t) / 1000;
    signLat.sort((a, b) => a - b);
    result.signInWarmup = { signIns: signLat.length, concurrency: 10, wallS: r1(wall), perS: r1(signLat.length / wall), p50: r1(pct(signLat, 50)), p95: r1(pct(signLat, 95)), p99: r1(pct(signLat, 99)) };
    log('sign-in warm-up', result.signInWarmup);

    const allLevels = [...levels];
    for (let li = 0; li < allLevels.length && li < MAX_LEVELS; li++) {
      const L = allLevels[li]!;
      const callId = f.calls[li]!;
      const slice = f.applicants.slice(li * PER_LEVEL_APPLICANTS, (li + 1) * PER_LEVEL_APPLICANTS);
      const applicants = mint ? await mintTokens(dataDir, slice) : slice;
      const common = { base: server.base, vus: L, durationMs, password: PASSWORD, callId, applicants, reviewers, officers, chairs };
      const lvl: any = { vus: L, steps: [] as any[] };

      const doStep = async (scenario: 'rush' | 'review' | 'decision', items?: string[]) => {
        const sizeBefore = dbBytes(f.dbFile);
        log(`L=${L} ${scenario} starting${items ? ` with ${items.length} work items` : ''}`);
        const cpu0 = processCpuMs(server.pid);
        const r: StepResult = await runStep({ ...common, scenario, items, readers, maxLifecycles: scenario === 'rush' ? perCall : undefined, durationMs: scenario === 'rush' ? durationMs : workMaxMs });
        const serverCpuPct = r1(((processCpuMs(server.pid) - cpu0) / (r.wallS * 1000)) * 100);
        const q = await waitQuiescent(f.dbFile);
        const lagType = scenario === 'rush' ? 'ProposalSubmitted' : scenario === 'review' ? 'ReviewSubmitted' : 'ProposalAwarded';
        const lag = deliveryLag(f.dbFile, r.startedAt, new Date().toISOString(), lagType);
        const lagAll = deliveryLag(f.dbFile, r.startedAt, new Date().toISOString(), null);
        const { acks: _a, ...rest } = r;
        const step = { ...rest, serverCpuPct, drainAfterStepMs: q.ms, pendingAfter: q.pending, failedDeliveries: q.failed, lag: { type: lagType, ...lag }, lagAllEvents: lagAll, dbBefore: sizeBefore, dbAfter: dbBytes(f.dbFile), workItems: items?.length ?? null };
        lvl.steps.push(step);
        log(
          `L=${L} ${scenario}: ${r.requests} req in ${r.wallS} s = ${r.rps} req/s, ${r.cmdps} cmd/s; p50 ${r.p50} p95 ${r.p95} p99 ${r.p99} ms (p95 w/o sign-in ${r.p95NoSignIn}); ` +
            `server CPU ${serverCpuPct}% of one core; errors ${r.errorCount} ${JSON.stringify(r.errors)}; refusals ${JSON.stringify(r.expectedRefusals)}; counters ${JSON.stringify(r.counters)}; ` +
            `drain ${q.ms} ms; ${lagType} lag p50/p95/p99/max ${lag.p50}/${lag.p95}/${lag.p99}/${lag.max} ms (n=${lag.events}); all-events lag p95 ${lagAll.p95} max ${lagAll.max}`,
        );
        return step;
      };

      try {
      await doStep('rush');
      if (scenarios.includes('review')) {
      const screening = (await getJson<any[]>(server.base, `/api/proposals?status=screening`, officers[0]!.token)).map((p) => p.id as string);
      await doStep('review', screening);
      const cases = (await getJson<any[]>(server.base, `/api/adjudications?open=1`, chairs[0]!.token)).filter((c) => c.status === 'awaitingDecision').map((c) => c.proposalId as string);
      await doStep('decision', cases);
      }
      } catch (e) {
        lvl.error = String(e);
        result.levels.push(lvl);
        log(`L=${L} aborted:`, e);
        break;
      }
      lvl.breached = lvl.steps.some((s: any) => s.p95 > 500 || s.errorCount > 0);
      lvl.breachedNoSignIn = lvl.steps.some((s: any) => s.p95NoSignIn > 500 || s.errorCount > 0);
      result.levels.push(lvl);
      writeFileSync(out, JSON.stringify(result, null, 2));
      if (extend && li === allLevels.length - 1 && !lvl.breachedNoSignIn && L * 2 <= 1600) allLevels.push(L * 2);
    }
  } finally {
    result.serverExit = server.exit;
    await stopServer(server);
    // serverExit non-null means the server died during the run (before the script stopped it)
    result.serverLog = scanServerLog(server.logFile);
    try {
      result.serverLogTail = readFileSync(server.logFile, 'utf8').split(/\r?\n/).slice(-40);
    } catch {
      /* ignore */
    }
    result.finalDb = dbBytes(f.dbFile);
    result.sourceStateAtEnd = gitState();
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(result, null, 2));
    log('server log scan', result.serverLog);
    log('wrote', out);
    if (!keep && !result.serverExit) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    } else log('kept', dataDir);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
void join;
