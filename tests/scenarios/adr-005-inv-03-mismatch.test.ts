/**
 * OPEN OWNER DECISION — ADR-005 vs INV-3. This test pins the code's CURRENT behaviour (ADR-005, proposed)
 * and exhibits the exact state INV-3's literal wording forbids. It is not a claim that the behaviour is
 * right: see docs/RELEASE_REPORT.md §6. If the owner chooses "void and re-score", this test is replaced.
 *
 * INV-3 (product/PRODUCT_REQUIREMENTS.md): a reviewer with a declared conflict "can never hold an
 * assignment" on that proposal; "a conflicted review is void".
 * ADR-005: after scoring, the completed assignment and its review stand, and the award is held.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness } from '../support/harness.ts';

let h: Harness;
beforeEach(async () => (h = await Harness.create()));
afterEach(async () => h.close());

describe('ADR-005 vs INV-3 (open owner decision)', () => {
  it('after scoring, a declared conflict coexists with a completed, non-revoked assignment whose review still counts', async () => {
    const w = h.world();
    const id = await h.scored(w);
    const meanBefore = h.one(`SELECT mean_score FROM rev_completion WHERE proposal_id = ?`, id).mean_score;

    const d = await h.post('/api/conflicts', w.r[0]!, { proposalId: id, reason: 'I realise I co-supervised the applicant.' });
    expect(d.status).toBe(201);
    expect(d.body).toMatchObject({ heldAward: true });
    expect(d.body.revokedAssignment ?? null).toBeNull();
    await h.settle();

    // the state INV-3's wording forbids: a conflict row AND a held (completed, ACTIVE) assignment for the same pair
    expect(h.one(`SELECT COUNT(*) n FROM rev_conflict WHERE proposal_id = ? AND reviewer_id = ?`, id, w.r[0]!.id).n).toBe(1);
    expect(h.one(`SELECT status FROM rev_assignment WHERE proposal_id = ? AND reviewer_id = ?`, id, w.r[0]!.id).status).toBe('completed');
    // the conflicted review is not void, and still contributes to the mean
    expect(h.one(`SELECT voided_at FROM rev_review WHERE proposal_id = ? AND reviewer_id = ?`, id, w.r[0]!.id).voided_at).toBeNull();
    expect(h.one(`SELECT mean_score FROM rev_completion WHERE proposal_id = ?`, id).mean_score).toBe(meanBefore);
    expect(h.status(id)).toBe('scored');

    // what ADR-005 does instead: the award is held, a decline remains, nothing releases the hold
    const award = await h.post(`/api/adjudications/${id}/decision`, w.chair, { outcome: 'award', rationale: 'Strongest proposal in the round.' });
    expect(award.body.error).toMatchObject({ code: 'integrity_hold', rule: 'INV-3' });
  });
});
