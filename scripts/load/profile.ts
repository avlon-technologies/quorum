/**
 * Where does the server's single thread spend its time under load? Runs Quorum IN THIS PROCESS
 * (createApp, as src/server.ts does, workers on, real systemClock) with the V8 CPU profiler on, drives
 * a load step from worker threads, and prints the top self-time functions.
 *
 *   node scripts/load/profile.ts [--scenario rush] [--vus 50] [--duration 20] [--port 3905] [--out docs/evidence/results/profile-rush.json]
 */
import { Session } from 'node:inspector/promises';
import { performance } from 'node:perf_hooks';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fixture, freshDataDir, signIn, getJson, waitQuiescent, gitState, r1, ROOT, PASSWORD } from './lib.ts';
import { runStep, type Tok } from './driver.ts';

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : def;
};
const scenario = arg('scenario', 'rush') as 'rush' | 'review';
const vus = Number(arg('vus', '50'));
const durationMs = Number(arg('duration', '20')) * 1000;
const port = Number(arg('port', '3905'));
const out = resolve(ROOT, arg('out', `docs/evidence/results/profile-${scenario}.json`));

process.env.QUORUM_RATE_LIMIT = '0';
process.env.QUORUM_DEMO = '0';

async function main() {
  const dataDir = freshDataDir('profile');
  process.env.QUORUM_DATA_DIR = dataDir;
  const f = await fixture(dataDir, { applicants: 3000, reviewers: 300, officers: 15, chairs: 5, calls: 1 });
  const { createApp } = await import('../../src/app.ts');
  const { systemClock } = await import('../../src/platform/clock.ts');
  const app = await createApp({ dbFile: f.dbFile, dataDir, demo: false, clock: systemClock });
  await app.http.listen({ port, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${port}`;
  const sign = async (a: { id: string; email: string }): Promise<Tok> => ({ ...a, token: await signIn(base, a.email, PASSWORD) });
  const officers = await Promise.all(f.officers.map(sign));
  const chairs = await Promise.all(f.chairs.map(sign));
  const reviewers: Tok[] = [];
  for (const r of f.reviewers) reviewers.push(await sign(r));
  const common = { base, password: PASSWORD, callId: f.calls[0]!, applicants: f.applicants, reviewers, officers, chairs, readers: true };
  let items: string[] | undefined;
  if (scenario === 'review') {
    await runStep({ ...common, scenario: 'rush', vus: 20, durationMs: 15_000 });
    await waitQuiescent(f.dbFile);
    items = (await getJson<any[]>(base, `/api/proposals?status=screening`, officers[0]!.token)).map((p) => p.id);
  }
  const session = new Session();
  session.connect();
  await session.post('Profiler.enable');
  await session.post('Profiler.setSamplingInterval', { interval: 500 });
  await session.post('Profiler.start');
  const elu0 = performance.eventLoopUtilization();
  const step = await runStep({ ...common, scenario, vus, durationMs, items });
  const elu = performance.eventLoopUtilization(elu0);
  const { profile } = (await session.post('Profiler.stop')) as any;
  session.disconnect();
  await app.close();

  // self time per function
  const nodes = new Map<number, any>(profile.nodes.map((n: any) => [n.id, n]));
  const self = new Map<number, number>();
  const dts: number[] = profile.timeDeltas;
  profile.samples.forEach((id: number, i: number) => self.set(id, (self.get(id) ?? 0) + (dts[i] ?? 0)));
  const byFn = new Map<string, number>();
  let total = 0;
  for (const [id, us] of self) {
    const n = nodes.get(id);
    const cf = n.callFrame;
    const key = `${cf.functionName || '(anonymous)'} ${cf.url ? basename(cf.url) + ':' + (cf.lineNumber + 1) : ''}`.trim();
    byFn.set(key, (byFn.get(key) ?? 0) + us);
    total += us;
  }
  // attribute each sample to its leaf plus the nearest application frame (src/), so native SQLite /
  // crypto time is charged to the code that called it
  const parent = new Map<number, number>();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const appFrame = (id: number): string => {
    let cur: number | undefined = id;
    while (cur !== undefined) {
      const cf = nodes.get(cur).callFrame;
      if (cf.url && /[\\/]src[\\/]/.test(cf.url)) return `${cf.functionName || '(anonymous)'} ${basename(cf.url)}:${cf.lineNumber + 1}`;
      cur = parent.get(cur);
    }
    return '(no app frame)';
  };
  const byApp = new Map<string, number>();
  for (const [id, us] of self) {
    const leaf = nodes.get(id).callFrame;
    if (leaf.functionName === '(idle)') continue;
    const key = `${leaf.functionName || '(anonymous)'}${leaf.url ? '' : ' [native]'} <- ${appFrame(id)}`;
    byApp.set(key, (byApp.get(key) ?? 0) + us);
  }
  const idle = byFn.get('(idle)') ?? 0;
  const busy = total - idle;
  const top = [...byFn.entries()]
    .filter(([k]) => k !== '(idle)')
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([fn, us]) => ({ fn, ms: Math.round(us / 1000), pctOfBusy: r1((us / busy) * 100) }));
  const result = {
    sourceState: gitState(),
    scenario,
    vus,
    note: 'In-process server (createApp, workers on); load from worker threads. Native SQLite time appears under the statement method that called it (run/get/all/transaction).',
    eventLoopUtilization: r1(elu.utilization * 100),
    step: { rps: step.rps, cmdps: step.cmdps, p50: step.p50, p95: step.p95, p99: step.p99, errors: step.errors, counters: step.counters },
    profileMs: Math.round(total / 1000),
    busyMs: Math.round(busy / 1000),
    top,
    byAppFrame: [...byApp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([fn, us]) => ({ fn, ms: Math.round(us / 1000), pctOfBusy: r1((us / busy) * 100) })),
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
void join;
