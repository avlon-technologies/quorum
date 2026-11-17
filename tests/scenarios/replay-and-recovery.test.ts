import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Harness } from '../support/harness.ts';
import { resetProjection } from '../../src/contexts/oversight/service.ts';

const CHILD = fileURLToPath(new URL('../support/crash-child.ts', import.meta.url));

let h: Harness;
beforeEach(async () => (h = await Harness.create()));
afterEach(async () => {
  h.deps.bus.faultInjector = undefined;
  await h.close();
});

function crashDuring(consumer: string, applicant: { id: string; name: string }, proposalId: string): Promise<{ code: number | null; signal: string | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CHILD, h.dbFile, h.dir, h.clock.now().toISOString(), applicant.id, applicant.name, proposalId, consumer], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('exit', (code, signal) => resolve({ code, signal, out }));
  });
}

function projection() {
  return {
    calls: h.all(`SELECT * FROM ovs_call ORDER BY call_id`),
    proposals: h.all(`SELECT * FROM ovs_proposal ORDER BY proposal_id`),
    audit: h.all(`SELECT * FROM ovs_audit ORDER BY seq`),
  };
}

describe('Event replay after interruption', () => {
  for (const consumer of ['notification.notification-service', 'oversight.portfolio-projector', 'submission.proposal-service']) {
    it(`a process killed inside ${consumer}'s delivery loses nothing and duplicates nothing after restart`, async () => {
      const w = h.world();
      await h.settle();
      const id = h.draft(w, w.alice);
      const run = await crashDuring(consumer, w.alice, id);
      expect(run.out).toContain(`killing inside ${consumer}`);
      expect(run.out).not.toContain('not killed');

      // after the crash: the event and the state change are durable; the interrupted delivery is not marked
      expect(h.count('ProposalSubmitted')).toBe(1);
      const msg = h.one(`SELECT message_id FROM evt_outbox WHERE type = 'ProposalSubmitted'`).message_id;
      expect(h.one(`SELECT status FROM evt_delivery WHERE consumer = ? AND message_id = ?`, consumer, msg).status).toBe('pending');

      // "restart": this process's dispatcher picks up exactly where the dead one stopped
      await h.settle();
      expect(h.one(`SELECT COUNT(*) n FROM evt_delivery WHERE status <> 'delivered'`).n).toBe(0);
      expect(h.one(`SELECT COUNT(*) n FROM ntf_message WHERE event_id = ?`, msg).n).toBe(2); // applicant + officers, once each
      expect(h.one(`SELECT COUNT(*) n FROM ovs_audit WHERE message_id = ?`, msg).n).toBe(1);
      expect(h.one(`SELECT COUNT(*) n FROM ovs_proposal WHERE proposal_id = ?`, id).n).toBe(1);
      expect(h.one(`SELECT COUNT(*) n FROM sub_triage_job WHERE proposal_id = ?`, id).n).toBe(1);
      expect(h.count('ProposalEnteredScreening')).toBe(1);
      expect(h.count('TriageProposed')).toBe(1);
      expect(h.status(id)).toBe('screening');
    }, 60_000);
  }

  it('a delivery that keeps failing is parked after 5 attempts and holds its partition; retry() releases it in order', async () => {
    const w = h.world();
    await h.settle();
    const consumer = 'notification.notification-service';
    let failing = true;
    h.deps.bus.faultInjector = (c, e) => {
      if (failing && c === consumer && e.type === 'ProposalSubmitted') throw new Error('mail templating outage (injected)');
    };
    const id = await h.submitted(w);
    for (let i = 0; i < 8; i++) {
      h.clock.advance(61_000);
      await h.settle();
    }
    const msg = h.one(`SELECT message_id FROM evt_outbox WHERE type = 'ProposalSubmitted'`).message_id;
    expect(h.one(`SELECT status, attempts FROM evt_delivery WHERE consumer = ? AND message_id = ?`, consumer, msg)).toMatchObject({ status: 'failed', attempts: 5 });
    expect(h.deps.bus.health().failed).toHaveLength(1);

    // a later event on the same proposal is held for this consumer (ordering over liveness) …
    expect((await h.post(`/api/proposals/${id}/screening`, w.officer, { outcome: 'eligible', reason: '' })).status).toBe(200);
    await h.settle();
    const later = h.one(`SELECT message_id FROM evt_outbox WHERE type = 'ProposalEligible'`).message_id;
    expect(h.one(`SELECT status FROM evt_delivery WHERE consumer = ? AND message_id = ?`, consumer, later).status).toBe('pending');
    // … but other consumers are not blocked
    expect(h.one(`SELECT status FROM evt_delivery WHERE consumer = 'oversight.portfolio-projector' AND message_id = ?`, later).status).toBe('delivered');

    // the officer retries through the operations API once the cause is fixed
    failing = false;
    const r = await h.post('/api/operations/deliveries/retry', w.operator, { consumer, messageId: msg });
    expect(r.status).toBe(200);
    expect(r.body.retried).toBe(true);
    await h.settle();
    expect(h.one(`SELECT COUNT(*) n FROM evt_delivery WHERE status <> 'delivered'`).n).toBe(0);
    const kinds = h.all(`SELECT kind FROM ntf_message WHERE recipient = ? ORDER BY created_at`, w.alice.id).map((x) => x.kind);
    expect(kinds).toEqual(['submitted', 'eligible']);
  });

  it('replaying the whole log into the portfolio projector rebuilds an identical projection', async () => {
    const w = h.world();
    const p1 = await h.scored(w, w.r.slice(0, 3), w.alice);
    await h.scored(w, w.r.slice(1, 4), w.bob);
    await h.submitted(w, w.sam);
    await h.post(`/api/adjudications/${p1}/decision`, w.chair, { outcome: 'award', rationale: 'The strongest proposal in the round.' });
    await h.settle();
    const before = projection();
    expect(before.audit.length).toBeGreaterThan(20);

    const n = h.deps.bus.replay('oversight.portfolio-projector', resetProjection);
    await h.settle();
    expect(n).toBe(before.audit.length);
    expect(projection()).toEqual(before);

    // and via the operations API
    const r = await h.post('/api/operations/rebuild-projections', w.operator, {});
    expect(r.status).toBe(200);
    await h.settle();
    expect(projection()).toEqual(before);
  });
});
