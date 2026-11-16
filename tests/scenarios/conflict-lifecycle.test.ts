import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness } from '../support/harness.ts';

let h: Harness;
beforeEach(async () => (h = await Harness.create()));
afterEach(async () => h.close());

const rationale = 'The panel found the proposal strong on every criterion.';

describe('Conflicted assignment across the review lifecycle (INV-3, ADR-005)', () => {
  it('a conflict declared after a submitted review but before scoring revokes the assignment and voids the review', async () => {
    const w = h.world();
    const id = await h.underReview(w);
    h.review(w, id, w.r[0]!);
    await h.settle();
    const reviewId = h.one(`SELECT id FROM rev_review WHERE proposal_id = ? AND reviewer_id = ?`, id, w.r[0]!.id).id;

    const d = await h.post('/api/conflicts', w.officer, { proposalId: id, reviewerId: w.r[0]!.id, reason: 'Undisclosed co-authorship discovered.' });
    expect(d.status).toBe(201);
    expect(d.body).toMatchObject({ heldAward: false });
    expect(d.body.revokedAssignment).toBeTruthy();
    expect(h.one(`SELECT voided_at FROM rev_review WHERE id = ?`, reviewId).voided_at).toBeTruthy();
    await h.settle();

    // replace the reviewer; the voided review never counts toward the three
    expect((await h.post(`/api/proposals/${id}/assignments`, w.officer, { reviewerId: w.r[3]!.id })).status).toBe(201);
    h.review(w, id, w.r[1]!);
    h.review(w, id, w.r[2]!);
    await h.settle();
    expect(h.status(id)).toBe('underReview');
    h.review(w, id, w.r[3]!);
    await h.settle();
    expect(h.status(id)).toBe('scored');
    const counted = JSON.parse(h.one(`SELECT review_ids FROM rev_completion WHERE proposal_id = ?`, id).review_ids);
    expect(counted).toHaveLength(3);
    expect(counted).not.toContain(reviewId);
    // the portfolio (events only, ADR-013) agrees: four reviews were submitted, three count
    expect(h.one(`SELECT reviews_submitted FROM ovs_proposal WHERE proposal_id = ?`, id).reviews_submitted).toBe(3);
  });

  it('a conflict declared after scoring holds the award: the chair is refused with 409 integrity_hold, a decline is still possible', async () => {
    const w = h.world();
    const id = await h.scored(w);
    const d = await h.post('/api/conflicts', w.officer, { proposalId: id, reviewerId: w.r[0]!.id, reason: 'Conflict disclosed after scoring.' });
    expect(d.status).toBe(201);
    expect(d.body.heldAward).toBe(true);
    await h.settle();
    expect(h.one(`SELECT integrity_hold FROM adj_case WHERE proposal_id = ?`, id).integrity_hold).toBeTruthy();

    const before = h.one(`SELECT committed_minor FROM adj_budget WHERE call_id = ?`, w.callId).committed_minor;
    const r = await h.post(`/api/adjudications/${id}/decision`, w.chair, { outcome: 'award', rationale });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'integrity_hold', rule: 'INV-3' });
    expect(h.one(`SELECT committed_minor FROM adj_budget WHERE call_id = ?`, w.callId).committed_minor).toBe(before);
    expect(h.count('ProposalAwarded')).toBe(0);

    const decline = await h.post(`/api/adjudications/${id}/decision`, w.chair, { outcome: 'decline', rationale: 'Declined pending an integrity review.' });
    expect(decline.status).toBe(200);
  });

  it('a reviewer cannot declare a conflict on behalf of another reviewer: 403', async () => {
    const w = h.world();
    const id = await h.underReview(w);
    const r = await h.post('/api/conflicts', w.r[0]!, { proposalId: id, reviewerId: w.r[1]!.id, reason: 'Trying to knock a peer off.' });
    expect(r.status).toBe(403);
    expect(h.one(`SELECT COUNT(*) n FROM rev_conflict`).n).toBe(0);
  });
});
