import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness } from '../support/harness.ts';

let h: Harness;
beforeEach(async () => (h = await Harness.create()));
afterEach(async () => h.close());

describe('Two-of-three panel readiness (INV-5, INV-8)', () => {
  it('two reviews: nothing reaches the panel; the third scores exactly once, even when ReviewSubmitted is redelivered', async () => {
    const w = h.world();
    const id = await h.underReview(w);
    h.review(w, id, w.r[0]!, 3);
    h.review(w, id, w.r[1]!, 4);
    await h.settle();
    expect(h.count('ProposalFullyReviewed')).toBe(0);
    expect(h.one(`SELECT COUNT(*) n FROM adj_case`).n).toBe(0);
    const early = await h.post(`/api/adjudications/${id}/decision`, w.chair, { outcome: 'award', rationale: 'Deciding on partial evidence.' });
    expect(early.status).toBe(409);
    expect(early.body.error).toMatchObject({ code: 'not_scored', rule: 'INV-8' });

    h.review(w, id, w.r[2]!, 5);
    await h.settle();
    expect(h.status(id)).toBe('scored');
    expect(h.count('ProposalFullyReviewed')).toBe(1);
    expect(h.count('ProposalScored')).toBe(1);
    expect(h.one(`SELECT mean_score FROM adj_case WHERE proposal_id = ?`, id).mean_score).toBe(4);

    // at-least-once delivery: force every ReviewSubmitted and ProposalFullyReviewed to be delivered again
    h.db.exec(
      `UPDATE evt_delivery SET status = 'pending' WHERE message_id IN (SELECT message_id FROM evt_outbox WHERE type IN ('ReviewSubmitted','ProposalFullyReviewed','ProposalScored'))`,
    );
    await h.settle();
    expect(h.count('ProposalFullyReviewed')).toBe(1);
    expect(h.count('ProposalScored')).toBe(1);
    expect(h.one(`SELECT COUNT(*) n FROM adj_case WHERE proposal_id = ?`, id).n).toBe(1);
    expect(h.one(`SELECT COUNT(*) n FROM ntf_message WHERE kind = 'scored'`).n).toBe(1);
  });
});
