/**
 * Rate limiter behaviour with the DEFAULT limiter on, when many virtual users share one demo account.
 *
 *   node scripts/load/limiter.ts [--vus 50] [--duration 20] [--port 3904] [--out docs/evidence/results/limiter.json]
 *
 * A fresh data dir with demo mode on (the server seeds the demo accounts). --vus users share
 * priya.raman@quorum.test (applicant: list proposals, save her draft) and --vus users share
 * officer@quorum.test (officer workspace, portfolio). Then 15 wrong-password sign-ins for one email.
 * Reports 2xx / 429 / other per account and when the first 429 appeared.
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { freshDataDir, startServer, stopServer, signIn, gitState, pct, r1, ROOT } from './lib.ts';

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : def;
};
const vus = Number(arg('vus', '50'));
const durationMs = Number(arg('duration', '20')) * 1000;
const port = Number(arg('port', '3904'));
const out = resolve(ROOT, arg('out', 'docs/evidence/results/limiter.json'));
const DEMO_PASSWORD = 'quorum-demo-2026'; // src/seed.ts DEMO_PASSWORD

async function main() {
  const dataDir = freshDataDir('limiter');
  const server = await startServer(port, dataDir, 'server.log', { QUORUM_DEMO: '1', QUORUM_RATE_LIMIT: '1' });
  const result: any = { sourceState: gitState(), config: { vus, durationMs, limiter: 'default (QUORUM_RATE_LIMIT unset/1)' } };
  try {
    const priya = await signIn(server.base, 'priya.raman@quorum.test', DEMO_PASSWORD);
    const officer = await signIn(server.base, 'officer@quorum.test', DEMO_PASSWORD);
    const drafts = (await (await fetch(`${server.base}/api/proposals`, { headers: { authorization: `Bearer ${priya}` } })).json()) as any[];
    const draft = drafts.find((p) => p.status === 'draft');
    const t0 = performance.now();
    const stats: Record<string, { ok: number; limited: number; other: Record<string, number>; first429S: number | null; ms: number[]; retryAfter: Set<string> }> = {};
    const rec = (k: string, status: number, ms: number, retryAfter: string | null, code?: string) => {
      const s = (stats[k] ??= { ok: 0, limited: 0, other: {}, first429S: null, ms: [], retryAfter: new Set() });
      s.ms.push(ms);
      if (status >= 200 && status < 300) s.ok++;
      else if (status === 429) {
        s.limited++;
        if (s.first429S === null) s.first429S = r1((performance.now() - t0) / 1000);
        if (retryAfter) s.retryAfter.add(retryAfter);
      } else s.other[`${status} ${code ?? ''}`] = (s.other[`${status} ${code ?? ''}`] ?? 0) + 1;
    };
    const call = async (k: string, method: string, path: string, token: string, body?: unknown) => {
      const s = performance.now();
      try {
        const r = await fetch(server.base + path, {
          method,
          headers: { authorization: `Bearer ${token}`, ...(method !== 'GET' ? { 'idempotency-key': randomUUID(), 'content-type': 'application/json' } : {}) },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const txt = await r.text();
        let code: string | undefined;
        try {
          code = JSON.parse(txt)?.error?.code;
        } catch {
          /* */
        }
        rec(k, r.status, performance.now() - s, r.headers.get('retry-after'), code);
      } catch (e) {
        rec(k, 0, performance.now() - s, null, String(e));
      }
    };
    const end = t0 + durationMs;
    const vu = async (i: number) => {
      while (performance.now() < end) {
        if (i % 2 === 0) {
          await call('priya reads (GET /api/proposals)', 'GET', '/api/proposals', priya);
          if (draft) await call('priya writes (PUT draft)', 'PUT', `/api/proposals/${draft.id}`, priya, { title: `Draft ${i}`, abstract: draft.abstract ?? '', requested: 1000 });
        } else {
          await call('officer reads (GET /api/workspace/officer)', 'GET', '/api/workspace/officer', officer);
          await call('officer reads (GET /api/portfolio)', 'GET', '/api/portfolio', officer);
        }
      }
    };
    await Promise.all(Array.from({ length: vus * 2 }, (_, i) => vu(i)));
    result.sharedAccounts = Object.fromEntries(
      Object.entries(stats).map(([k, s]) => {
        const ms = s.ms.sort((a, b) => a - b);
        return [k, { requests: ms.length, ok: s.ok, limited429: s.limited, other: s.other, first429AfterS: s.first429S, retryAfterValues: [...s.retryAfter].slice(0, 5), p50: r1(pct(ms, 50)), p95: r1(pct(ms, 95)) }];
      }),
    );
    // correct sign-ins from ONE address (every client behind one NAT, or every client when a reverse proxy
    // fronts the server and Fastify's trustProxy is off): anonymous POSTs share the per-ip write bucket
    {
      const emails = ['priya.raman@quorum.test', 'mateo.alvarez@quorum.test', 'kwame.mensah@quorum.test', 'elena.petrova@quorum.test', 'liam.oconnor@quorum.test', 'sarah.chen@quorum.test'];
      const by: Record<string, number> = {};
      let first429: number | null = null;
      for (let i = 0; i < 150; i++) {
        const r = await fetch(`${server.base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: emails[i % emails.length], password: DEMO_PASSWORD }) });
        await r.arrayBuffer();
        by[String(r.status)] = (by[String(r.status)] ?? 0) + 1;
        if (r.status === 429 && first429 === null) first429 = i + 1;
      }
      result.correctSignInsFromOneIp = { attempts: 150, byStatus: by, first429AtAttempt: first429 };
    }
    // wrong-password sign-ins for one email
    const signin: Record<string, number> = {};
    for (let i = 0; i < 15; i++) {
      const r = await fetch(`${server.base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'chair@quorum.test', password: 'wrong-password' }) });
      signin[String(r.status)] = (signin[String(r.status)] ?? 0) + 1;
    }
    const good = await fetch(`${server.base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'chair@quorum.test', password: DEMO_PASSWORD }) });
    result.wrongPasswordSignIns = { attempts: 15, byStatus: signin, thenCorrectPasswordStatus: good.status };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await stopServer(server);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(result, null, 2));
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
