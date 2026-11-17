/**
 * Runs one load step: spreads N virtual users over worker threads (vu-worker.ts), collects every
 * request sample and summarizes throughput, latency percentiles and errors.
 */
import { Worker } from 'node:worker_threads';
import { pct, r1, type Account } from './lib.ts';

export type Tok = Account & { token: string };
export type StepInput = {
  base: string;
  scenario: 'rush' | 'review' | 'decision';
  vus: number;
  durationMs: number;
  password: string;
  callId: string;
  applicants: Array<Account & { token?: string }>;
  items?: string[];
  reviewers: Tok[];
  officers: Tok[];
  chairs: Tok[];
  awardShare?: number;
  readers?: boolean;
  ack?: boolean;
  timeoutMs?: number;
  workers?: number;
  /** rush: total lifecycles to start across all workers (default unlimited) */
  maxLifecycles?: number;
};

const EXPECTED = new Set(['not_assignable', 'integrity_pending', 'envelope_exceeded', 'envelope_exhausted']);

export type LabelStat = { label: string; n: number; p50: number; p95: number; p99: number; max: number; errors: number };
export type StepResult = {
  scenario: string;
  vus: number;
  startedAt: string;
  endedAt: string;
  wallS: number;
  requests: number;
  rps: number;
  commandsOk: number;
  cmdps: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  p95NoSignIn: number;
  expectedRefusals: Record<string, number>;
  errors: Record<string, number>;
  errorCount: number;
  counters: Record<string, number>;
  perLabel: LabelStat[];
  acks: Array<{ kind: string; proposalId: string; key: string; title?: string; actor: string }>;
  /** throughput per 1 s bucket, to show warm-up / stalls */
  timeline: number[];
};

export async function runStep(s: StepInput): Promise<StepResult> {
  const W = Math.max(1, Math.min(s.workers ?? 4, s.vus));
  const items = s.items ?? [];
  const startedAt = new Date().toISOString();
  const outs = await Promise.all(
    Array.from({ length: W }, (_, w) => {
      const vus = Math.floor(s.vus / W) + (w < s.vus % W ? 1 : 0);
      const vuOffset = Array.from({ length: w }, (_, k) => Math.floor(s.vus / W) + (k < s.vus % W ? 1 : 0)).reduce((a, b) => a + b, 0);
      const share = <T>(arr: T[]) => arr.filter((_, i) => i % W === w);
      return new Promise<any>((resolve, reject) => {
        const worker = new Worker(new URL('./vu-worker.ts', import.meta.url), {
          workerData: {
            base: s.base,
            scenario: s.scenario,
            vus,
            vuOffset,
            totalVus: s.vus,
            durationMs: s.durationMs,
            password: s.password,
            callId: s.callId,
            applicants: share(s.applicants),
            items: share(items),
            reviewers: s.reviewers,
            officers: s.officers,
            chairs: s.chairs,
            awardShare: s.awardShare ?? 0.3,
            readers: s.readers ?? true,
            ack: s.ack ?? false,
            timeoutMs: s.timeoutMs ?? 30_000,
            maxLifecycles: s.maxLifecycles === undefined ? undefined : Math.ceil(s.maxLifecycles / W),
          },
        });
        worker.once('message', (m) => (m.fatal ? reject(new Error(m.fatal)) : resolve(m)));
        worker.once('error', reject);
      });
    }),
  );
  const endedAt = new Date().toISOString();
  return summarize(s.scenario, s.vus, startedAt, endedAt, outs);
}

function summarize(scenario: string, vus: number, startedAt: string, endedAt: string, outs: any[]): StepResult {
  const all: number[] = [];
  const noSignIn: number[] = [];
  const per = new Map<string, { ms: number[]; errors: number }>();
  const errors: Record<string, number> = {};
  const expectedRefusals: Record<string, number> = {};
  const counters: Record<string, number> = {};
  const acks: StepResult['acks'] = [];
  let commandsOk = 0;
  let wallMs = 0;
  const buckets: number[] = [];
  for (const o of outs) {
    wallMs = Math.max(wallMs, o.wallMs);
    for (const [k, v] of Object.entries(o.counters as Record<string, number>)) counters[k] = (counters[k] ?? 0) + v;
    acks.push(...o.acks);
    for (let i = 0; i < o.sMs.length; i++) {
      const label = o.labels[o.sLabel[i]] as string;
      const ms = o.sMs[i] as number;
      const status = o.sStatus[i] as number;
      const code = o.codes[o.sCode[i]] as string;
      all.push(ms);
      if (!label.endsWith('/api/session')) noSignIn.push(ms);
      const p = per.get(label) ?? { ms: [], errors: 0 };
      p.ms.push(ms);
      per.set(label, p);
      const b = Math.floor(o.sEnd[i] / 1000);
      buckets[b] = (buckets[b] ?? 0) + 1;
      if (status >= 200 && status < 300) {
        if (o.sWrite[i] && !label.endsWith('/api/session')) commandsOk++;
      } else if (status === 409 && EXPECTED.has(code)) {
        expectedRefusals[code] = (expectedRefusals[code] ?? 0) + 1;
      } else {
        const k = status === 0 ? code : `${status} ${code}`;
        errors[k] = (errors[k] ?? 0) + 1;
        p.errors++;
      }
    }
  }
  all.sort((a, b) => a - b);
  noSignIn.sort((a, b) => a - b);
  const wallS = wallMs / 1000;
  const perLabel: LabelStat[] = [...per.entries()]
    .map(([label, v]) => {
      const m = v.ms.sort((a, b) => a - b);
      return { label, n: m.length, p50: r1(pct(m, 50)), p95: r1(pct(m, 95)), p99: r1(pct(m, 99)), max: r1(m.at(-1) ?? NaN), errors: v.errors };
    })
    .sort((a, b) => b.n - a.n);
  return {
    scenario,
    vus,
    startedAt,
    endedAt,
    wallS: r1(wallS),
    requests: all.length,
    rps: r1(all.length / wallS),
    commandsOk,
    cmdps: r1(commandsOk / wallS),
    p50: r1(pct(all, 50)),
    p95: r1(pct(all, 95)),
    p99: r1(pct(all, 99)),
    max: r1(all.at(-1) ?? NaN),
    p95NoSignIn: r1(pct(noSignIn, 95)),
    expectedRefusals,
    errors,
    errorCount: Object.values(errors).reduce((a, b) => a + b, 0),
    counters,
    perLabel,
    acks,
    timeline: Array.from(buckets, (x) => x ?? 0),
  };
}
