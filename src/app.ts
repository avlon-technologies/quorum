/**
 * Composition root — realizes ::Quorum.QuorumServer (one process: HTTP API, static UI, event
 * dispatcher, triage runner, overdue/escalation sweeper, outbound-message drain).
 *
 * Startup is predictable: open + migrate the database, register every consumer (a consumer that
 * subscribes to an event the model does not declare fails startup), register every route (a route
 * without an access declaration fails startup), then resume: pending deliveries, triage instances,
 * due sweeps and queued messages are all re-read from the database — nothing lives only in memory.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { openDb, type Db } from './platform/db.ts';
import { type Clock, systemClock } from './platform/clock.ts';
import { EventBus } from './platform/events.ts';
import { TokenService, loadSecret } from './platform/auth.ts';
import { installHttp } from './platform/http.ts';
import type { Deps } from './platform/deps.ts';
import { orcidFromEnv, type OrcidClient } from './integrations/orcid.ts';
import { StubTriageProvider, type TriageProvider } from './integrations/triage-provider.ts';
import { FileMailTransport, type MailTransport } from './integrations/mail.ts';
import { loadPrincipal } from './contexts/identity/service.ts';
import { submissionConsumer } from './contexts/submission/service.ts';
import { triageConsumer, TriageRunner } from './contexts/submission/triage.ts';
import { peerReviewConsumer } from './contexts/peer-review/service.ts';
import { sweepOverdue } from './contexts/peer-review/review-deadline.ts';
import { completionConsumer } from './contexts/peer-review/completion.ts';
import { adjudicationConsumer } from './contexts/adjudication/service.ts';
import { panelDecisionWorkflow, sweepEscalations } from './contexts/adjudication/panel-decision.ts';
import { notificationConsumer, drainOutbound } from './contexts/notification/service.ts';
import { projectorConsumer } from './contexts/oversight/service.ts';
import { registerRoutes } from './api/routes.ts';

export type AppOptions = {
  dbFile?: string;
  dataDir?: string;
  clock?: Clock;
  orcid?: OrcidClient;
  triage?: TriageProvider;
  mail?: MailTransport;
  demo?: boolean;
  /** Clock for session expiry. Wall-clock by default: moving the demo/business clock must not sign anyone out. */
  sessionClock?: Clock;
  logger?: boolean;
  /** Start background workers (dispatcher poll, triage, sweeps, drain). Tests drive them by hand. */
  workers?: boolean;
};

export type App = {
  http: FastifyInstance;
  deps: Deps;
  triageRunner: TriageRunner;
  /** Run every background step once, to quiescence. Deterministic; used by tests and the demo clock. */
  settle: () => Promise<void>;
  close: () => Promise<void>;
};

export function createDeps(o: AppOptions & { db?: Db } = {}): Deps {
  const dataDir = o.dataDir ?? process.env.QUORUM_DATA_DIR ?? 'data';
  const clock = o.clock ?? systemClock;
  const db = o.db ?? openDb(o.dbFile ?? process.env.QUORUM_DB ?? join(dataDir, 'quorum.sqlite'));
  const bus = new EventBus(db, clock);
  const deps: Deps = {
    db,
    clock,
    bus,
    orcid: o.orcid ?? orcidFromEnv(),
    triage: o.triage ?? new StubTriageProvider(),
    mail: o.mail ?? new FileMailTransport(join(dataDir, 'mail-outbox.jsonl')),
    config: { reviewPeriodDays: 21, decisionPeriodDays: 14, demo: o.demo ?? process.env.QUORUM_DEMO === '1' },
  };
  for (const c of [
    submissionConsumer(deps),
    triageConsumer(deps),
    peerReviewConsumer(deps),
    completionConsumer(deps),
    adjudicationConsumer(deps),
    panelDecisionWorkflow(deps),
    notificationConsumer(deps),
    projectorConsumer(deps),
  ]) {
    bus.register(c);
  }
  return deps;
}

export async function createApp(o: AppOptions = {}): Promise<App> {
  const dataDir = o.dataDir ?? process.env.QUORUM_DATA_DIR ?? 'data';
  const deps = createDeps(o);
  const tokens = new TokenService(loadSecret(dataDir), o.sessionClock ?? systemClock);
  const http = Fastify({
    logger: o.logger ? { level: process.env.LOG_LEVEL ?? 'info' } : false,
    bodyLimit: 256 * 1024,
    genReqId: () => `req_${Math.random().toString(36).slice(2, 10)}`,
    ajv: { customOptions: { allErrors: true, removeAdditional: false, coerceTypes: false } },
  });
  const h = installHttp(http, { db: deps.db, clock: deps.clock, tokens, loadPrincipal: (id) => loadPrincipal(deps, id) });
  await http.register(fastifyStatic, { root: join(fileURLToPath(new URL('.', import.meta.url)), '..', 'public'), wildcard: false });
  http.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    );
    return payload;
  });

  const triageRunner = new TriageRunner(deps);
  const emailOf = (recipient: string) => {
    if (recipient.startsWith('role:')) return `${recipient.slice(5)}@quorum.local`;
    const r = deps.db.prepare(`SELECT email FROM idn_account WHERE id = ?`).get(recipient) as { email: string } | undefined;
    return r?.email ?? `${recipient}@quorum.local`;
  };

  const settle = async () => {
    for (let i = 0; i < 20; i++) {
      let work = deps.bus.drain();
      work += await triageRunner.runOnce();
      work += sweepOverdue(deps);
      work += sweepEscalations(deps);
      work += deps.bus.drain();
      work += await drainOutbound(deps, emailOf);
      if (work === 0) return;
    }
  };

  registerRoutes(h, deps, tokens, { settle, triageRunner });

  const timers: NodeJS.Timeout[] = [];
  if (o.workers !== false) {
    deps.bus.start(1000);
    triageRunner.start(1500);
    // Triage runs in-process right after a submission is dispatched, so the officer sees it promptly.
    deps.bus.afterDrain.push(() => void triageRunner.runOnce().then((n) => n && deps.bus.kick()));
    const sweep = setInterval(() => {
      try {
        sweepOverdue(deps);
        sweepEscalations(deps);
      } catch (e) {
        console.error('[sweeper]', e);
      }
      void drainOutbound(deps, emailOf).catch((e) => console.error('[mail-drain]', e));
    }, 5000);
    sweep.unref();
    timers.push(sweep);
  }

  return {
    http,
    deps,
    triageRunner,
    settle,
    close: async () => {
      deps.bus.stop();
      triageRunner.stop();
      for (const t of timers) clearInterval(t);
      await http.close();
      deps.db.close();
    },
  };
}
