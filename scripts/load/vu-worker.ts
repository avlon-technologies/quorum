/**
 * Virtual-user worker (worker_threads). Runs a share of the virtual users for one load step against
 * the real HTTP API and posts every request's timing back to the main thread.
 *
 * Scenarios (each VU runs its script back-to-back, no think time, until the step ends or work runs out):
 *   rush      applicant: sign in (token reused afterwards) -> list calls -> create empty draft ->
 *             save draft twice -> read it -> submit -> list own proposals
 *   review    officer: workspace -> proposal -> confirm eligible -> reviewer candidates -> assign x3
 *             (retrying while the case is still being opened asynchronously) -> list assignments;
 *             then each of the 3 reviewers: list assignments -> accept -> open assignment ->
 *             submit scores -> read peer reviews -> notifications
 *   decision  chair: (every 5th case) case list + portfolio -> case -> reviews -> timeline ->
 *             decide (award ~30 %, falling back to decline when the envelope refuses)
 * In every scenario ~20 % of the VUs are staff readers (portfolio, officer workspace, case list,
 * activity) with a 1 s pause between page loads.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

type Acc = { id: string; email: string; token?: string };
type Input = {
  base: string;
  scenario: 'rush' | 'review' | 'decision';
  vus: number;
  vuOffset: number;
  totalVus: number;
  durationMs: number;
  password: string;
  callId: string;
  applicants: Acc[];
  items: string[];
  reviewers: Array<Acc & { token: string }>;
  officers: Array<Acc & { token: string }>;
  chairs: Array<Acc & { token: string }>;
  awardShare: number;
  readers: boolean;
  /** durability mode: report every acknowledged command */
  ack?: boolean;
  timeoutMs: number;
  /** rush: stop after this many lifecycles have been started by this worker (one call's worth across workers) */
  maxLifecycles?: number;
};

const I = workerData as Input;
const EXPECTED_409 = new Set(['not_assignable', 'integrity_pending', 'envelope_exceeded', 'already_assigned', 'panel_full']);

// Compact sample columns: label index, method flag, latency, status, code index, end time
const labels: string[] = [];
const codes: string[] = [''];
const sLabel: number[] = [];
const sMs: number[] = [];
const sStatus: number[] = [];
const sCode: number[] = [];
const sEnd: number[] = [];
const sWrite: number[] = [];
const acks: Array<{ kind: string; proposalId: string; key: string; title?: string; actor: string }> = [];
const counters = { lifecycles: 0, asyncWaits: 0, awards: 0, declines: 0, refusedAwards: 0, workExhausted: 0 };
const idx = (arr: string[], v: string) => {
  let i = arr.indexOf(v);
  if (i < 0) i = arr.push(v) - 1;
  return i;
};
const t0 = performance.now();
const deadline = t0 + I.durationMs;
let writersDone = false;
const timeUp = () => writersDone || performance.now() >= deadline;
let rushStarted = 0;

type Res = { status: number; body: any };
async function req(method: string, path: string, label: string, token: string | null, body?: unknown, key?: string): Promise<Res> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (method !== 'GET') headers['idempotency-key'] = key ?? randomUUID();
  if (body !== undefined) headers['content-type'] = 'application/json';
  const start = performance.now();
  let status = 0;
  let parsed: any = null;
  let code = '';
  try {
    const r = await fetch(I.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(I.timeoutMs) });
    status = r.status;
    const text = await r.text();
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (status >= 400) code = parsed?.error?.code ?? `http_${status}`;
  } catch (e) {
    code = (e as Error)?.name === 'TimeoutError' ? 'timeout' : `network:${(e as Error)?.message ?? e}`.slice(0, 80);
  }
  const end = performance.now();
  sLabel.push(idx(labels, `${method} ${label}`));
  sMs.push(end - start);
  sStatus.push(status);
  sCode.push(code ? idx(codes, code) : 0);
  sEnd.push(end - t0);
  sWrite.push(method === 'GET' ? 0 : 1);
  return { status, body: parsed };
}

const tokens = new Map<string, string>();
async function tokenFor(a: Acc): Promise<string | null> {
  const t = tokens.get(a.id) ?? a.token;
  if (t) return t;
  const r = await req('POST', '/api/session', '/api/session', null, { email: a.email, password: I.password }, 'n/a-session');
  if (r.status !== 200) return null;
  tokens.set(a.id, r.body.token);
  return r.body.token as string;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------- rush
let applicantCursor = 0;
async function rushVu(): Promise<void> {
  while (!timeUp()) {
    if (I.maxLifecycles !== undefined && rushStarted >= I.maxLifecycles) return;
    rushStarted++;
    const a = I.applicants[applicantCursor++ % I.applicants.length]!;
    const tok = await tokenFor(a);
    if (!tok) continue;
    await req('GET', '/api/calls', '/api/calls', tok);
    const k0 = randomUUID();
    const created = await req('POST', '/api/proposals', '/api/proposals', tok, { callId: I.callId, title: '', abstract: '', requested: 0 }, k0);
    if (created.status !== 201) continue;
    const id = created.body.id as string;
    if (I.ack) acks.push({ kind: 'create', proposalId: id, key: k0, actor: a.id });
    const title1 = `Draft ${id.slice(0, 8)}`;
    const k1 = randomUUID();
    const u1 = await req('PUT', `/api/proposals/${id}`, '/api/proposals/:id', tok, { title: title1, abstract: ABSTRACT.slice(0, 120), requested: 50_000 }, k1);
    if (I.ack && u1.status === 200) acks.push({ kind: 'update', proposalId: id, key: k1, title: title1, actor: a.id });
    const title2 = `Community early warning ${id.slice(0, 8)}`;
    const k2 = randomUUID();
    const u2 = await req('PUT', `/api/proposals/${id}`, '/api/proposals/:id', tok, { title: title2, abstract: ABSTRACT, requested: 50_000 + Math.floor(Math.random() * 150_000) }, k2);
    if (I.ack && u2.status === 200) acks.push({ kind: 'update', proposalId: id, key: k2, title: title2, actor: a.id });
    await req('GET', `/api/proposals/${id}`, '/api/proposals/:id', tok);
    const k3 = randomUUID();
    const s = await req('POST', `/api/proposals/${id}/submit`, '/api/proposals/:id/submit', tok, undefined, k3);
    if (s.status === 200) {
      counters.lifecycles++;
      if (I.ack) acks.push({ kind: 'submit', proposalId: id, key: k3, actor: a.id });
    }
    await req('GET', '/api/proposals', '/api/proposals', tok);
  }
}

// ---------------------------------------------------------------------------------------- review
let itemCursor = 0;
const nextItem = () => (itemCursor < I.items.length ? I.items[itemCursor++]! : null);

async function reviewVu(vu: number): Promise<void> {
  const officer = I.officers[vu % I.officers.length]!;
  while (!timeUp()) {
    const pid = nextItem();
    if (!pid) {
      counters.workExhausted++;
      return;
    }
    const o = officer.token;
    await req('GET', '/api/workspace/officer', '/api/workspace/officer', o);
    await req('GET', `/api/proposals/${pid}`, '/api/proposals/:id', o);
    const sc = await req('POST', `/api/proposals/${pid}/screening`, '/api/proposals/:id/screening', o, { outcome: 'eligible', reason: 'In scope and complete.' });
    if (sc.status !== 200) continue;
    await req('GET', `/api/proposals/${pid}/reviewer-candidates`, '/api/proposals/:id/reviewer-candidates', o);
    const chosen: Array<{ r: (typeof I.reviewers)[number]; assignmentId: string }> = [];
    const tried = new Set<number>();
    let guard = 0;
    while (chosen.length < 3 && guard++ < 400 && !timeUp()) {
      let ri = Math.floor(Math.random() * I.reviewers.length);
      while (tried.has(ri)) ri = (ri + 1) % I.reviewers.length;
      const rv = I.reviewers[ri]!;
      const key = randomUUID();
      const a = await req('POST', `/api/proposals/${pid}/assignments`, '/api/proposals/:id/assignments', o, { reviewerId: rv.id }, key);
      if (a.status === 201) {
        tried.add(ri);
        chosen.push({ r: rv, assignmentId: a.body.id });
      } else if (a.status === 409 && a.body?.error?.code === 'not_assignable') {
        counters.asyncWaits++; // the review case is opened by an event consumer; the officer's UI would show "not yet"
        await pause(20);
      } else {
        tried.add(ri);
      }
    }
    await req('GET', `/api/proposals/${pid}/assignments`, '/api/proposals/:id/assignments', o);
    for (const { r, assignmentId } of chosen) {
      await req('GET', '/api/assignments', '/api/assignments', r.token);
      await req('POST', `/api/assignments/${assignmentId}/accept`, '/api/assignments/:id/accept', r.token);
      const d = await req('GET', `/api/assignments/${assignmentId}`, '/api/assignments/:id', r.token);
      const criteria = (d.body?.criteria ?? []) as Array<{ id: string }>;
      const scores = Object.fromEntries(criteria.map((c) => [c.id, 1 + Math.floor(Math.random() * 5)]));
      await req('POST', `/api/assignments/${assignmentId}/review`, '/api/assignments/:id/review', r.token, {
        scores,
        comment: 'A careful, well-justified proposal with a credible plan, a strong team and clear community benefit.',
        attestsNoConflict: true,
      });
      await req('GET', `/api/proposals/${pid}/reviews`, '/api/proposals/:id/reviews', r.token);
      await req('GET', '/api/notifications', '/api/notifications', r.token);
    }
    if (chosen.length === 3) counters.lifecycles++;
  }
}

// ---------------------------------------------------------------------------------------- decision
async function decisionVu(vu: number): Promise<void> {
  const chair = I.chairs[vu % I.chairs.length]!;
  let n = 0;
  while (!timeUp()) {
    const pid = nextItem();
    if (!pid) {
      counters.workExhausted++;
      return;
    }
    const c = chair.token;
    if (n++ % 5 === 0) {
      await req('GET', '/api/adjudications', '/api/adjudications', c);
      await req('GET', '/api/portfolio', '/api/portfolio', c);
    }
    await req('GET', `/api/adjudications/${pid}`, '/api/adjudications/:id', c);
    await req('GET', `/api/proposals/${pid}/reviews`, '/api/proposals/:id/reviews', c);
    await req('GET', `/api/proposals/${pid}/timeline`, '/api/proposals/:id/timeline', c);
    let outcome: 'award' | 'decline' = Math.random() < I.awardShare ? 'award' : 'decline';
    for (let attempt = 0; attempt < 200 && !timeUp(); attempt++) {
      const d = await req('POST', `/api/adjudications/${pid}/decision`, '/api/adjudications/:id/decision', c, {
        outcome,
        rationale: outcome === 'award' ? 'Ranked within the fundable band by the panel.' : 'Below the funding line after panel discussion.',
      });
      if (d.status === 200) {
        if (outcome === 'award') counters.awards++;
        else counters.declines++;
        counters.lifecycles++;
        break;
      }
      const code = d.body?.error?.code;
      if (code === 'integrity_pending') {
        counters.asyncWaits++;
        await pause(20);
        continue;
      }
      if (code === 'envelope_exceeded' || code === 'envelope_exhausted') {
        counters.refusedAwards++;
        outcome = 'decline';
        continue;
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------------------- staff reader
async function readerVu(vu: number): Promise<void> {
  const officer = I.officers[vu % I.officers.length]!;
  const chair = I.chairs[vu % I.chairs.length]!;
  const pages: Array<[string, string]> = [
    ['/api/portfolio', chair.token],
    ['/api/workspace/officer', officer.token],
    ['/api/adjudications', chair.token],
    ['/api/activity', officer.token],
  ];
  let i = vu;
  while (!timeUp()) {
    const [path, tok] = pages[i++ % pages.length]!;
    await req('GET', path, path, tok);
    await pause(1000);
  }
}

const ABSTRACT =
  'Thawing permafrost is destabilising roads, water lines and building foundations across northern communities, yet residents learn of ground ' +
  'failure only after damage occurs. We propose a community-operated early-warning network that combines low-cost ground temperature sensors, ' +
  'satellite deformation data and local knowledge of land change. Over three years we will co-design the network with four hamlets, validate a ' +
  'thaw-risk model against field observations, and hand over dashboards and maintenance training so that infrastructure decisions are made months, ' +
  'not days, ahead of failure. The project directly strengthens climate resilience in northern communities and publishes open data and a playbook.';

async function main() {
  const writers: Promise<void>[] = [];
  const readers: Promise<void>[] = [];
  for (let v = 0; v < I.vus; v++) {
    const g = I.vuOffset + v; // global VU number
    const isReader = I.readers && I.totalVus >= 5 && g % 5 === 4;
    if (isReader) readers.push(readerVu(g));
    else if (I.scenario === 'rush') writers.push(rushVu());
    else if (I.scenario === 'review') writers.push(reviewVu(g));
    else writers.push(decisionVu(g));
  }
  await Promise.all(writers);
  writersDone = true; // staff readers stop when this worker's writers have finished their work
  await Promise.all(readers);
  parentPort!.postMessage({ labels, codes, sLabel, sMs, sStatus, sCode, sEnd, sWrite, counters, acks, wallMs: performance.now() - t0 });
}

main().catch((e) => {
  parentPort!.postMessage({ fatal: String(e?.stack ?? e) });
});
