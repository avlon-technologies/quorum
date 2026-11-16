import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness } from '../support/harness.ts';

let h: Harness;
beforeEach(async () => (h = await Harness.create()));
afterEach(async () => h.close());

describe('INV-5 — exactly three submitted reviews before scored', () => {
  it('two submitted reviews do not score the proposal: no ProposalFullyReviewed, still underReview', async () => {
    const w = h.world();
    const id = await h.underReview(w);
    h.review(w, id, w.r[0]!);
    h.review(w, id, w.r[1]!);
    await h.settle();
    expect(h.status(id)).toBe('underReview');
    expect(h.count('ProposalFullyReviewed')).toBe(0);
    expect(h.count('ProposalScored')).toBe(0);
  });

  it('refuses a fourth reviewer: 409 panel_full, no assignment, no event', async () => {
    const w = h.world();
    const id = await h.underReview(w);
    const before = h.totalEvents();
    const r = await h.post(`/api/proposals/${id}/assignments`, w.officer, { reviewerId: w.r[3]!.id });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'panel_full', rule: 'INV-5' });
    expect(h.one(`SELECT COUNT(*) n FROM rev_assignment WHERE proposal_id = ?`, id).n).toBe(3);
    expect(h.totalEvents()).toBe(before);
  });
});
