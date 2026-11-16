// acceptance/adapter.mjs — binds the package's step keys to the REAL Quorum implementation.
//
// This is not a reference realization: every step drives the application itself, in-process, through the same
// HTTP routes, services, SQLite store and transactional outbox that `npm start` runs (tests/support/harness.ts
// builds an isolated instance per scenario on a temporary database with a manual clock and the stub ORCID/triage
// providers that the LocalDevelopment bindings name). A scenario that passes here is executed behaviour of the code.
//
// THE CONTRACT (acceptance/run.mjs): createAdapter({ createFakeProvider, env }) → { steps, beforeScenario?, afterScenario? }
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Harness, DAY_MS } from '../../tests/support/harness.ts';
import { AGENT_ACTOR } from '../../src/platform/deps.ts';
import { acceptAssignment } from '../../src/contexts/peer-review/service.ts';

export const clock = {
  now: (ctx) => ctx.state.h?.clock.now() ?? new Date(),
  set: (ctx, when) => ctx.state.h.clock.set(new Date(when)),
};

const CRASH_CHILD = fileURLToPath(new URL('../../tests/support/crash-child.ts', import.meta.url));
const RATIONALE = 'Decision recorded by the acceptance scenario with a full rationale.';

function fail(msg, detail) {
  throw new Error(detail === undefined ? msg : `${msg} — got ${JSON.stringify(detail).slice(0, 400)}`);
}
function expectEq(actual, expected, what) {
  if (actual !== expected) fail(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Resolve a scenario's reviewer reference: an index into the world's verified reviewers, or a named account. */
function who(ctx, ref) {
  const w = ctx.state.w;
  if (typeof ref === 'number') return w.r[ref];
  if (ref in w) return w[ref];
  fail(`unknown actor reference ${JSON.stringify(ref)}`);
}
const pid = (ctx, name) => ctx.state.p[name] ?? fail(`proposal ${name} was never prepared`);

function projection(h) {
  return {
    calls: h.all(`SELECT * FROM ovs_call ORDER BY call_id`),
    proposals: h.all(`SELECT * FROM ovs_proposal ORDER BY proposal_id`),
    audit: h.all(`SELECT * FROM ovs_audit ORDER BY seq`),
  };
}

async function submitReviewVia(ctx, proposal, reviewerRef, scores) {
  const { h, w } = ctx.state;
  const reviewer = who(ctx, reviewerRef);
  const a = h.assignment(pid(ctx, proposal), reviewer);
  const st = h.one(`SELECT status FROM rev_assignment WHERE id = ?`, a).status;
  if (st === 'assigned') h.tx(() => acceptAssignment(h.deps, reviewer.id, a));
  const all = h.scores(w, 4);
  if (scores === 'missing-one') delete all[Object.keys(all).at(-1)];
  ctx.state.last = await h.post(`/api/assignments/${a}/review`, reviewer, {
    scores: all,
    comment: 'A careful, well-justified proposal with a credible plan and a strong team.',
    attestsNoConflict: true,
  });
  await h.settle();
  return ctx.state.last;
}

async function decide(ctx, proposal, outcome) {
  const { h, w } = ctx.state;
  await h.settle();
  ctx.state.last = await h.post(`/api/adjudications/${pid(ctx, proposal)}/decision`, w.chair, { outcome, rationale: RATIONALE });
  await h.settle();
  return ctx.state.last;
}

export function createAdapter() {
  return {
    beforeScenario(ctx) {
      ctx.state = { p: {}, owner: {} };
    },
    async afterScenario(ctx) {
      await ctx.state.h?.close();
    },
    steps: {
      // ---------------------------------------------------------------- given
      'quorum.running': async (ctx, args = {}) => {
        const h = await Harness.create();
        ctx.state.h = h;
        ctx.state.w = h.world({ envelope: args.envelope, maxRequest: args.maxRequest });
        h.agentAccount();
        await h.settle();
      },
      'proposal.prepared': async (ctx, { proposal, stage, applicant }) => {
        const { h, w } = ctx.state;
        const owner = applicant ? who(ctx, applicant) : w.alice;
        const make = { draft: async () => h.draft(w, owner), submitted: () => h.submitted(w, owner), eligible: () => h.eligible(w, owner), underReview: () => h.underReview(w, w.r.slice(0, 3), owner) }[stage];
        if (!make) fail(`unknown stage ${stage}`);
        ctx.state.p[proposal] = await make();
        ctx.state.owner[proposal] = owner;
        // a settled submission has already entered screening (ProposalSubmitted → ProposalEnteredScreening)
        expectEq(h.status(ctx.state.p[proposal]), stage === 'submitted' ? 'screening' : stage, `${proposal} status after preparation`);
      },
      'proposals.scored': async (ctx, { proposals, requested }) => {
        const { h, w } = ctx.state;
        for (const name of proposals) {
          ctx.state.p[name] = await h.scored(w, w.r.slice(0, 3), w.alice, { requested });
          ctx.state.owner[name] = w.alice;
          expectEq(h.status(ctx.state.p[name]), 'scored', `${name} status`);
        }
      },
      'conflict.declared': async (ctx, { proposal, reviewer }) => {
        const { h, w } = ctx.state;
        const r = await h.post('/api/conflicts', w.officer, { proposalId: pid(ctx, proposal), reviewerId: who(ctx, reviewer).id, reason: 'Co-author within the last three years.' });
        if (r.status !== 201 && r.status !== 200) fail('declaring the conflict', { status: r.status, body: r.body });
        await h.settle();
      },
      'review.submitted': async (ctx, { proposal, reviewers }) => {
        for (const r of reviewers) expectEq((await submitReviewVia(ctx, proposal, r, 'complete')).status, 200, `review by reviewer ${r}`);
      },
      'decision.recorded': async (ctx, { proposal, outcome }) => {
        expectEq((await decide(ctx, proposal, outcome)).status, 200, `${outcome} of ${proposal}`);
      },

      // ---------------------------------------------------------------- when
      'proposal.submit': async (ctx, { proposal, at }) => {
        const { h, w } = ctx.state;
        if (at === 'deadline') h.clock.set(new Date(w.deadline));
        ctx.state.last = await h.post(`/api/proposals/${pid(ctx, proposal)}/submit`, ctx.state.owner[proposal], {});
        await h.settle();
      },
      'reviewer.assign': async (ctx, { proposal, reviewer }) => {
        const { h, w } = ctx.state;
        ctx.state.last = await h.post(`/api/proposals/${pid(ctx, proposal)}/assignments`, w.officer, { reviewerId: who(ctx, reviewer).id });
        await h.settle();
      },
      'review.submit': async (ctx, { proposal, reviewer, scores }) => {
        await submitReviewVia(ctx, proposal, reviewer, scores);
      },
      'reviews.read': async (ctx, { proposal, reviewer }) => {
        ctx.state.last = await ctx.state.h.get(`/api/proposals/${pid(ctx, proposal)}/reviews`, who(ctx, reviewer));
      },
      'decision.record': async (ctx, { proposal, outcome }) => {
        await decide(ctx, proposal, outcome);
      },
      'triage.runs': async (ctx) => {
        await ctx.state.h.settle(); // the TriageRunner is one of the workers settle() drives
      },
      'foreign.proposal.read': async (ctx, { proposal, as }) => {
        ctx.state.last = await ctx.state.h.get(`/api/proposals/${pid(ctx, proposal)}`, who(ctx, as));
      },
      'clock.advanced': async (ctx, { days }) => {
        ctx.state.h.clock.advance(days * DAY_MS);
        await ctx.state.h.settle();
      },
      'delivery.interrupted': async (ctx, { proposal, consumer }) => {
        const { h } = ctx.state;
        const owner = ctx.state.owner[proposal];
        // a separate process submits, then is SIGKILLed inside `consumer`'s delivery, before it is marked delivered
        const out = await new Promise((resolve) => {
          const p = spawn(process.execPath, [CRASH_CHILD, h.dbFile, h.dir, h.clock.now().toISOString(), owner.id, owner.name, pid(ctx, proposal), consumer], { stdio: ['ignore', 'pipe', 'pipe'] });
          let s = '';
          p.stdout.on('data', (d) => (s += d));
          p.on('exit', () => resolve(s));
        });
        if (!out.includes(`killing inside ${consumer}`)) fail('the delivery was not interrupted', out);
        const msg = h.one(`SELECT message_id FROM evt_outbox WHERE type = 'ProposalSubmitted'`).message_id;
        expectEq(h.one(`SELECT status FROM evt_delivery WHERE consumer = ? AND message_id = ?`, consumer, msg).status, 'pending', 'interrupted delivery after the crash');
        await h.settle(); // "restart": this process's dispatcher resumes from the durable outbox
      },

      // ---------------------------------------------------------------- then
      'command.refused': async (ctx, { status, code, rule }) => {
        const r = ctx.state.last;
        if (r.status !== status || r.body?.error?.code !== code || (rule && r.body?.error?.rule !== rule)) fail(`expected ${status} ${code} ${rule ?? ''}`, { status: r.status, body: r.body });
      },
      'response.status': async (ctx, { status }) => expectEq(ctx.state.last.status, status, 'response status'),
      'event.count': async (ctx, { type, count }) => {
        await ctx.state.h.settle();
        expectEq(ctx.state.h.count(type), count, `${type} events`);
      },
      'proposal.status': async (ctx, { proposal, status }) => expectEq(ctx.state.h.status(pid(ctx, proposal)), status, `${proposal} status`),
      'delivery.redelivered': async (ctx, { type }) => {
        const { h } = ctx.state;
        h.db.prepare(`UPDATE evt_delivery SET status = 'pending' WHERE message_id IN (SELECT message_id FROM evt_outbox WHERE type = ?)`).run(type);
        await h.settle();
      },
      'reviews.visible': async (ctx, { count }) => {
        const r = ctx.state.last;
        expectEq(r.status, 200, 'reading reviews');
        expectEq(r.body.reviews.length, count, 'visible reviews');
      },
      'budget.committed': async (ctx, { committed, envelope }) => {
        const b = ctx.state.h.one(`SELECT committed_minor, envelope_minor FROM adj_budget WHERE call_id = ?`, ctx.state.w.callId);
        expectEq(b.committed_minor, committed * 100, 'committed (minor units)');
        expectEq(b.envelope_minor, envelope * 100, 'envelope (minor units)');
      },
      'decision.record.outcome': async (ctx, { proposal, award, decline }) => {
        expectEq((await decide(ctx, proposal, 'award')).status, award, 'award attempt in reconsider');
        expectEq((await decide(ctx, proposal, 'decline')).status, decline, 'decline in reconsider');
      },
      'agent.screening.refused': async (ctx, { proposal, status }) => {
        const { h } = ctx.state;
        const token = await h.mintToken(AGENT_ACTOR);
        const r = await h.post(`/api/proposals/${pid(ctx, proposal)}/screening`, token, { outcome: 'ineligible', reason: 'The agent tries to screen this proposal out.' });
        if (r.status !== status || r.body?.error?.code !== 'forbidden') fail(`expected ${status} forbidden`, { status: r.status, body: r.body });
        expectEq(h.status(pid(ctx, proposal)), 'screening', 'status after the agent attempt');
      },
      'call.publish.as': async (ctx, { as, status, rule }) => {
        const r = await ctx.state.h.post('/api/calls', who(ctx, as), {
          title: 'A call nobody authorized',
          summary: 'An applicant trying to publish a funding call for themselves.',
          deadline: '2030-01-01T00:00:00Z',
          envelope: 1000,
          maxRequest: 1000,
          criteria: [{ name: 'Merit', guidance: '' }],
        });
        if (r.status !== status || r.body?.error?.rule !== rule) fail(`expected ${status} ${rule}`, { status: r.status, body: r.body });
      },
      'review.submit.accepted': async (ctx, { proposal, reviewer }) => {
        expectEq((await submitReviewVia(ctx, proposal, reviewer, 'complete')).status, 200, 'late review');
      },
      'consumers.applied.once': async (ctx, { type }) => {
        const { h } = ctx.state;
        expectEq(h.count(type), 1, `${type} events`);
        const msg = h.one(`SELECT message_id FROM evt_outbox WHERE type = ?`, type).message_id;
        expectEq(h.one(`SELECT COUNT(*) n FROM evt_delivery WHERE message_id = ? AND status <> 'delivered'`, msg).n, 0, 'undelivered rows');
        expectEq(h.one(`SELECT COUNT(*) n FROM ovs_audit WHERE message_id = ?`, msg).n, 1, 'audit rows for the message');
        expectEq(h.one(`SELECT COUNT(*) n FROM ntf_message WHERE event_id = ?`, msg).n, 2, 'notifications (applicant + officers)');
        expectEq(h.count('ProposalEnteredScreening'), 1, 'ProposalEnteredScreening events');
      },
      'projection.replays.identically': async (ctx) => {
        const { h, w } = ctx.state;
        const before = JSON.stringify(projection(h));
        const r = await h.post('/api/operations/rebuild-projections', w.officer, {});
        expectEq(r.status, 200, 'rebuild');
        await h.settle();
        if (JSON.stringify(projection(h)) !== before) fail('the replayed projection differs from the live one');
      },
      'portfolio.shows': async (ctx, { proposal, status, committed }) => {
        const { h, w } = ctx.state;
        await h.settle();
        const r = await h.get('/api/portfolio', w.officer);
        expectEq(r.status, 200, 'portfolio');
        const call = (r.body.calls ?? r.body).find((c) => c.callId === w.callId);
        const p = call.proposals.find((x) => x.proposalId === pid(ctx, proposal));
        expectEq(p?.status, status, 'portfolio status');
        expectEq(call.committedMinor, committed * 100, 'portfolio committed');
      },
      'timeline.has': async (ctx, { proposal, events }) => {
        const { h, w } = ctx.state;
        const r = await h.get(`/api/proposals/${pid(ctx, proposal)}/timeline`, w.officer);
        expectEq(r.status, 200, 'timeline');
        const rows = r.body.timeline ?? r.body.events ?? r.body;
        for (const e of events) {
          const row = rows.find((x) => x.event === e);
          if (!row) fail(`timeline lacks ${e}`, rows.map((x) => x.event));
          if (!row.actorId && !row.actor) fail(`timeline entry ${e} has no actor`, row);
        }
      },
    },
  };
}

