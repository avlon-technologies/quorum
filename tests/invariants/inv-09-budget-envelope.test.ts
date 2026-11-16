import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness } from '../support/harness.ts';

let h: Harness;
beforeEach(async () => (h = await Harness.create()));
afterEach(async () => h.close());

const rationale = 'The panel found the proposal strong on every criterion.';

describe('INV-9 — awards never exceed the call envelope', () => {
  it('refuses an award that would exceed the envelope: 409 envelope_exceeded, nothing committed, no ProposalAwarded', async () => {
    const w = h.world({ envelope: 150_000, maxRequest: 100_000 });
    const p1 = await h.scored(w, w.r.slice(0, 3), w.alice, { requested: 100_000 });
    const p2 = await h.scored(w, w.r.slice(0, 3), w.bob, { requested: 60_000 });
    expect((await h.post(`/api/adjudications/${p1}/decision`, w.chair, { outcome: 'award', rationale })).status).toBe(200);
    await h.settle();
    const committed = h.one(`SELECT committed_minor FROM adj_budget WHERE call_id = ?`, w.callId).committed_minor;
    expect(committed).toBe(10_000_000);

    const r = await h.post(`/api/adjudications/${p2}/decision`, w.chair, { outcome: 'award', rationale });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'envelope_exceeded', rule: 'INV-9' });
    await h.settle();
    expect(h.one(`SELECT committed_minor FROM adj_budget WHERE call_id = ?`, w.callId).committed_minor).toBe(committed);
    expect(h.count('ProposalAwarded', { proposalId: p2 })).toBe(0);
    expect(h.status(p2)).toBe('scored');
    // the refusal itself is committed: the case moves to reconsider, which admits only a decline
    expect(h.one(`SELECT status FROM adj_case WHERE proposal_id = ?`, p2).status).toBe('reconsider');
  });

  it('after a refusal, a second award attempt is refused (envelope_exhausted) and only a decline is accepted', async () => {
    const w = h.world({ envelope: 150_000, maxRequest: 100_000 });
    const p1 = await h.scored(w, w.r.slice(0, 3), w.alice, { requested: 100_000 });
    const p2 = await h.scored(w, w.r.slice(0, 3), w.bob, { requested: 60_000 });
    await h.post(`/api/adjudications/${p1}/decision`, w.chair, { outcome: 'award', rationale });
    await h.post(`/api/adjudications/${p2}/decision`, w.chair, { outcome: 'award', rationale });
    const again = await h.post(`/api/adjudications/${p2}/decision`, w.chair, { outcome: 'award', rationale });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'envelope_exhausted', rule: 'INV-9' });
    const decline = await h.post(`/api/adjudications/${p2}/decision`, w.chair, { outcome: 'decline', rationale: 'The envelope cannot fund this proposal.' });
    expect(decline.status).toBe(200);
    await h.settle();
    expect(h.status(p2)).toBe('declined');
  });

  it('the database CHECK constraint refuses an over-commit even if the conditional update were bypassed', async () => {
    const w = h.world({ envelope: 150_000, maxRequest: 100_000 });
    await h.settle();
    expect(() => h.db.prepare(`UPDATE adj_budget SET committed_minor = envelope_minor + 1 WHERE call_id = ?`).run(w.callId)).toThrow(/CHECK/);
  });
});
