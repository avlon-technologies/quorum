/**
 * Durability under load: hard-kill the server during a write burst, restart it, and verify.
 *
 *   node scripts/load/crash.ts [--rounds 3] [--vus 50] [--kill-after 6] [--port 3902] [--out docs/evidence/results/crash.json]
 *
 * Each round: a deadline-rush burst (create, save x2, submit) at --vus virtual users; after
 * --kill-after seconds the server process is terminated (child.kill('SIGKILL') = TerminateProcess on
 * that PID only, no shutdown handler runs). The database is then inspected read-only, the server is
 * restarted on the same data directory, and the script checks that:
 *   - every command acknowledged with 2xx before the kill is present (cmd_log row for actor+key, and
 *     its effect: the draft exists, an acknowledged save's title or a later one is current, an
 *     acknowledged submit is no longer a draft);
 *   - every delivery pending at the kill completes after restart (pending = 0, failed = 0), every
 *     ProposalSubmitted reached all its consumers and every submitted proposal reached screening;
 *   - replaying an acknowledged submit with its Idempotency-Key returns the stored response.
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fixture, freshDataDir, startServer, stopServer, signIn, waitQuiescent, openRo, scanServerLog, gitState, mintTokens, sleep, ROOT, PASSWORD } from './lib.ts';
import { runStep, type StepResult } from './driver.ts';

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : def;
};
const rounds = Number(arg('rounds', '3'));
const vus = Number(arg('vus', '50'));
const killAfterMs = Number(arg('kill-after', '6')) * 1000;
const port = Number(arg('port', '3902'));
const mint = process.argv.includes('--mint');
const out = resolve(ROOT, arg('out', 'docs/evidence/results/crash.json'));
const log = (...a: unknown[]) => console.log(`[crash ${new Date().toISOString().slice(11, 19)}]`, ...a);

async function main() {
  const dataDir = freshDataDir('crash');
  const f = await fixture(dataDir, { applicants: 3000 * rounds, reviewers: 10, officers: 2, chairs: 1, calls: 1 });
  const result: any = { sourceState: gitState(), config: { rounds, vus, killAfterMs, applicantTokens: mint ? 'minted' : 'sign-in per applicant' }, rounds: [], dataDir };
  const allAcks: StepResult['acks'] = [];
  let server = await startServer(port, dataDir, 'server-0.log');
  try {
    for (let round = 0; round < rounds; round++) {
      const slice = f.applicants.slice(round * 3000, (round + 1) * 3000);
      const applicants = mint ? await mintTokens(dataDir, slice) : slice;
      log(`round ${round + 1}: burst at ${vus} VUs, kill pid ${server.pid} after ${killAfterMs} ms`);
      const victim = server;
      let killedAt = '';
      const killer = (async () => {
        await sleep(killAfterMs);
        killedAt = new Date().toISOString();
        await stopServer(victim);
      })();
      const step = await runStep({
        base: server.base,
        scenario: 'rush',
        vus,
        durationMs: killAfterMs + 1000,
        password: PASSWORD,
        callId: f.calls[0]!,
        applicants,
        reviewers: [],
        officers: [],
        chairs: [],
        readers: false,
        ack: true,
        timeoutMs: 5000,
      });
      await killer;
      const acks = step.acks;
      allAcks.push(...acks);
      const ackedBeforeKill = acks.length;

      // ---- state left on disk at the kill (read-only; the WAL is replayed by the reader)
      const ro = openRo(f.dbFile);
      const atKill = ro.prepare(`SELECT SUM(status='pending') pending, SUM(status='failed') failed, COUNT(*) total FROM evt_delivery`).get() as any;
      const undeliveredSubmits = (ro.prepare(
        `SELECT COUNT(DISTINCT o.message_id) n FROM evt_outbox o JOIN evt_delivery d ON d.message_id = o.message_id WHERE o.type = 'ProposalSubmitted' AND d.status <> 'delivered'`,
      ).get() as any).n;
      const stuckSubmitted = (ro.prepare(`SELECT COUNT(*) n FROM sub_proposal WHERE status = 'submitted'`).get() as any).n;
      ro.close();
      log(`round ${round + 1}: killed at ${killedAt}; ${ackedBeforeKill} commands acknowledged; on disk: ${atKill.pending} deliveries pending, ${undeliveredSubmits} ProposalSubmitted not yet at every consumer, ${stuckSubmitted} proposals still 'submitted'`);

      // ---- restart and let the dispatcher catch up
      const t0 = Date.now();
      server = await startServer(port, dataDir, `server-${round + 1}.log`);
      const restartMs = Date.now() - t0;
      const q = await waitQuiescent(f.dbFile, 120_000);
      log(`round ${round + 1}: restarted pid ${server.pid} in ${restartMs} ms; outbox drained in ${q.ms} ms (pending ${q.pending}, failed ${q.failed})`);

      // ---- verify every acknowledged command (cumulative over rounds)
      const db = openRo(f.dbFile);
      const hasCmd = db.prepare(`SELECT 1 FROM cmd_log WHERE actor_id = ? AND idempotency_key = ?`);
      const prop = db.prepare(`SELECT status, title FROM sub_proposal WHERE id = ?`);
      const missingCmd: string[] = [];
      const missingEffect: string[] = [];
      const lastAckedTitle = new Map<string, string>();
      for (const a of allAcks) if (a.kind === 'update') lastAckedTitle.set(a.proposalId, a.title!);
      for (const a of allAcks) {
        if (!hasCmd.get(a.actor, a.key)) missingCmd.push(`${a.kind} ${a.proposalId} ${a.key}`);
        const p = prop.get(a.proposalId) as { status: string; title: string } | undefined;
        if (!p) {
          missingEffect.push(`${a.kind} ${a.proposalId}: proposal missing`);
          continue;
        }
        if (a.kind === 'submit' && p.status === 'draft') missingEffect.push(`submit ${a.proposalId}: still draft`);
        if (a.kind === 'update' && lastAckedTitle.get(a.proposalId) === a.title) {
          // the newest acknowledged save, or a later save that was in flight at the kill
          if (p.title !== a.title && !p.title.startsWith('Community early warning')) missingEffect.push(`update ${a.proposalId}: title ${p.title} != ${a.title}`);
        }
      }
      const submittedIds = [...new Set(allAcks.filter((a) => a.kind === 'submit').map((a) => a.proposalId))];
      const notScreened = submittedIds.filter((id) => (prop.get(id) as any)?.status === 'submitted').length;
      const del = db.prepare(`SELECT SUM(status='pending') pending, SUM(status='failed') failed, SUM(status='delivered') delivered, COUNT(*) total FROM evt_delivery`).get() as any;
      const submitsNotEverywhere = (db.prepare(
        `SELECT COUNT(DISTINCT o.message_id) n FROM evt_outbox o JOIN evt_delivery d ON d.message_id = o.message_id WHERE o.type = 'ProposalSubmitted' AND d.status <> 'delivered'`,
      ).get() as any).n;
      const dupSubmits = (db.prepare(`SELECT COUNT(*) n FROM (SELECT json_extract(payload,'$.proposalId') p FROM evt_outbox WHERE type='ProposalSubmitted' GROUP BY p HAVING COUNT(*) > 1)`).get() as any).n;
      const triageNotDone = (db.prepare(`SELECT COUNT(*) n FROM sub_triage_job WHERE status <> 'done'`).get() as any).n;
      const integrity = (db.prepare(`PRAGMA quick_check`).get() as any).quick_check;
      db.close();

      // ---- idempotent replay of acknowledged submits
      let replayOk = 0;
      let replayTried = 0;
      for (const a of allAcks.filter((x) => x.kind === 'submit').slice(-10)) {
        const email = f.applicants.find((x) => x.id === a.actor)!.email;
        const tok = await signIn(server.base, email);
        const r = await fetch(`${server.base}/api/proposals/${a.proposalId}/submit`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'idempotency-key': a.key } });
        replayTried++;
        if (r.status === 200 && r.headers.get('idempotent-replay') === 'true') replayOk++;
      }
      // after restart, a fresh delivery health read through the API (the officer role may move to 'operator')
      let apiHealth: unknown = null;
      try {
        const tok = await signIn(server.base, f.officers[0]!.email);
        const r = await fetch(`${server.base}/api/operations/health`, { headers: { authorization: `Bearer ${tok}` } });
        apiHealth = r.status === 200 ? await r.json() : `HTTP ${r.status}`;
      } catch (e) {
        apiHealth = String(e);
      }
      const rr = {
        round: round + 1,
        killedAt,
        killedPid: victim.pid,
        requestsBeforeKill: step.requests,
        errorsAroundKill: step.errors,
        acknowledgedThisRound: ackedBeforeKill,
        acknowledgedCumulative: allAcks.length,
        byKind: Object.fromEntries(['create', 'update', 'submit'].map((k) => [k, allAcks.filter((a) => a.kind === k).length])),
        onDiskAtKill: { pendingDeliveries: atKill.pending ?? 0, failedDeliveries: atKill.failed ?? 0, totalDeliveries: atKill.total, proposalSubmittedNotAtEveryConsumer: undeliveredSubmits, proposalsStillSubmitted: stuckSubmitted },
        restartMs,
        drainAfterRestartMs: q.ms,
        afterRestart: {
          missingCommandLog: missingCmd.length,
          missingEffects: missingEffect.length,
          missingSamples: [...missingCmd, ...missingEffect].slice(0, 5),
          deliveries: del,
          proposalSubmittedNotAtEveryConsumer: submitsNotEverywhere,
          acknowledgedSubmitsNotInScreening: notScreened,
          duplicateProposalSubmittedEvents: dupSubmits,
          triageJobsNotDone: triageNotDone,
          quickCheck: integrity,
          idempotentReplay: `${replayOk}/${replayTried}`,
          apiHealth,
        },
      };
      result.rounds.push(rr);
      log(`round ${round + 1}:`, JSON.stringify(rr.afterRestart));
    }
  } finally {
    await stopServer(server);
    result.serverLogs = Array.from({ length: rounds + 1 }, (_, i) => scanServerLog(`${dataDir}/server-${i}.log`));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(result, null, 2));
    log('wrote', out);
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
