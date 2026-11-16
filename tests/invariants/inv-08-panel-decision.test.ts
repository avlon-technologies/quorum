import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness } from '../support/harness.ts';

let h: Harness;
beforeEach(async () => (h = await Harness.create()));
afterEach(async () => h.close());

const rationale = 'The panel found the proposal strong on every criterion.';

describe('INV-8 — only a PanelChair decides, and only for a scored proposal', () => {
  it('refuses a decision on a proposal that is not scored: 409 not_scored, no decision, no event', async () => {
    const w = h.world();
    const id = await h.underReview(w);
    const before = h.totalEvents();
    const r = await h.post(`/api/adjudications/${id}/decision`, w.chair, { outcome: 'award', rationale });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'not_scored', rule: 'INV-8' });
    expect(h.one(`SELECT COUNT(*) n FROM adj_decision`).n).toBe(0);
    expect(h.status(id)).toBe('underReview');
    expect(h.totalEvents()).toBe(before);
  });

  it('refuses a decision by a program officer (not a chair): 403 forbidden, nothing decided', async () => {
    const w = h.world();
    const id = await h.scored(w);
    const before = h.totalEvents();
    const r = await h.post(`/api/adjudications/${id}/decision`, w.officer, { outcome: 'award', rationale });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatchObject({ code: 'forbidden', rule: 'INV-11' });
    expect(h.one(`SELECT COUNT(*) n FROM adj_decision`).n).toBe(0);
    expect(h.totalEvents()).toBe(before);
  });

  it('refuses a second decision: 409 already_decided, the first stands', async () => {
    const w = h.world();
    const id = await h.scored(w);
    expect((await h.post(`/api/adjudications/${id}/decision`, w.chair, { outcome: 'decline', rationale })).status).toBe(200);
    await h.settle();
    const before = h.totalEvents();
    const r = await h.post(`/api/adjudications/${id}/decision`, w.chair, { outcome: 'award', rationale });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'already_decided', rule: 'INV-8' });
    expect(h.one(`SELECT outcome FROM adj_decision WHERE proposal_id = ?`, id).outcome).toBe('decline');
    expect(h.status(id)).toBe('declined');
    expect(h.totalEvents()).toBe(before);
  });
});
