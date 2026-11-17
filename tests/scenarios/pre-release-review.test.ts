/**
 * Regression tests for the findings of the architect's pre-release review (docs/RELEASE_REPORT.md §5).
 * Each one failed against the code as it stood before the fix.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness } from '../support/harness.ts';

let h: Harness;
beforeEach(async () => (h = await Harness.create()));
afterEach(async () => {
  h.deps.bus.faultInjector = undefined;
  await h.close();
});
const rationale = 'The panel judged this the strongest proposal in the round.';

async function drainWithRetries(rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    h.clock.advance(61_000);
    await h.settle();
  }
}

describe('Pre-release review regressions', () => {
  it('A1: the portfolio committed total is right even when an earlier award reaches the projector last', async () => {
    const w = h.world({ envelope: 300_000, maxRequest: 150_000 });
    const p1 = await h.scored(w, w.r.slice(0, 3), w.alice, { requested: 100_000 });
    const p2 = await h.scored(w, w.r.slice(0, 3), w.bob, { requested: 50_000 });
    let failing = true;
    h.deps.bus.faultInjector = (c, e) => {
      if (failing && c === 'oversight.portfolio-projector' && e.type === 'ProposalAwarded' && (e.payload as any).proposalId === p1) throw new Error('projector outage (injected)');
    };
    expect((await h.post(`/api/adjudications/${p1}/decision`, w.chair, { outcome: 'award', rationale })).status).toBe(200);
    expect((await h.post(`/api/adjudications/${p2}/decision`, w.chair, { outcome: 'award', rationale })).status).toBe(200);
    await h.settle(); // p2's award (higher seq) is projected; p1's is retrying
    failing = false;
    await drainWithRetries();
    const call = (await h.get('/api/portfolio', w.officer)).body.calls?.find?.((c: any) => c.callId === w.callId) ?? (await h.get('/api/portfolio', w.officer)).body.find((c: any) => c.callId === w.callId);
    expect(call.committedMinor).toBe(15_000_000);

    // and a full rebuild reproduces it
    expect((await h.post('/api/operations/rebuild-projections', w.operator, {})).status).toBe(200);
    await h.settle();
    expect(h.one(`SELECT awarded_minor FROM ovs_call WHERE call_id = ?`, w.callId).awarded_minor).toBe(15_000_000);
  });

  it('A2: an award is refused (fail closed) while a late ConflictDeclared has not reached Adjudication', async () => {
    const w = h.world();
    const id = await h.scored(w);
    h.deps.bus.faultInjector = (c, e) => {
      if (c === 'adjudication.adjudication-service' && e.type === 'ConflictDeclared') throw new Error('adjudication consumer outage (injected)');
    };
    const d = await h.post('/api/conflicts', w.officer, { proposalId: id, reviewerId: w.r[0]!.id, reason: 'Conflict disclosed after scoring.' });
    expect(d.body.heldAward).toBe(true);
    await h.settle();
    const r = await h.post(`/api/adjudications/${id}/decision`, w.chair, { outcome: 'award', rationale });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'integrity_pending', rule: 'INV-3' });
    expect(h.count('ProposalAwarded')).toBe(0);
  });

  it('A2: a conflict that lands before the adjudication case exists still holds the award', async () => {
    const w = h.world();
    let blockCase = true;
    h.deps.bus.faultInjector = (c, e) => {
      if (blockCase && c === 'adjudication.panel-decision-workflow' && e.type === 'ProposalScored') throw new Error('case creation delayed (injected)');
    };
    const id = await h.scored(w);
    expect(h.one(`SELECT COUNT(*) n FROM adj_case WHERE proposal_id = ?`, id).n).toBe(0);
    await h.post('/api/conflicts', w.officer, { proposalId: id, reviewerId: w.r[0]!.id, reason: 'Conflict disclosed after scoring.' });
    await h.settle();
    blockCase = false;
    await drainWithRetries();
    expect(h.one(`SELECT integrity_hold FROM adj_case WHERE proposal_id = ?`, id).integrity_hold).toBeTruthy();
    const r = await h.post(`/api/adjudications/${id}/decision`, w.chair, { outcome: 'award', rationale });
    expect(r.body.error).toMatchObject({ code: 'integrity_hold', rule: 'INV-3' });
  });

  it('B2: a malformed agent verdict is a failed attempt, not a silently lost triage', async () => {
    const w = h.world();
    h.triage.assess = async () => ({ verdict: 'reject' as any, rationale: 'not a declared verdict' });
    const id = await h.submitted(w);
    await drainWithRetries(4);
    expect(h.one(`SELECT status FROM sub_triage_job WHERE proposal_id = ?`, id).status).toBe('done');
    expect(h.one(`SELECT verdict FROM sub_triage WHERE proposal_id = ?`, id).verdict).toBeNull();
    expect(h.count('TriageProposed')).toBe(1);
    expect(h.status(id)).toBe('screening');
  });

  it('B5: a reviewer whose assignment was revoked can no longer open it', async () => {
    const w = h.world();
    const id = await h.underReview(w);
    const a = h.assignment(id, w.r[0]!);
    expect((await h.get(`/api/assignments/${a}`, w.r[0]!)).status).toBe(200);
    expect((await h.post('/api/conflicts', w.r[0]!, { proposalId: id, reason: 'I co-authored with the applicant last year.' })).status).toBe(201);
    expect((await h.get(`/api/assignments/${a}`, w.r[0]!)).status).toBe(404);
  });
});
